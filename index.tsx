/* tslint:disable */
/// <reference lib="dom" />
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import {
  GenerateContentResponse,
  GenerateVideosParameters,
  GoogleGenAI,
  Chat,
  Tool,
  Type
} from '@google/genai';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';


const GEMINI_API_KEY = process.env.API_KEY;

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function blobToBase64(blob: Blob) {
  return new Promise<string>(async (resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = reader.result as string;
      resolve(url.split(',')[1]);
    };
    reader.readAsDataURL(blob);
  });
}

async function generateContent(
  prompt: string,
  imageBytes: string,
  aspectRatio: string,
  duration: number,
  resolution: string,
) {
  const ai = new GoogleGenAI({apiKey: GEMINI_API_KEY});

  const config: GenerateVideosParameters = {
    model: 'veo-2.0-generate-001',
    prompt,
    config: {
      aspectRatio,
      durationSeconds: duration,
      resolution,
      numberOfVideos: 1,
    },
  };

  if (imageBytes) {
    config.image = {
      imageBytes,
      mimeType: 'image/png',
    };
  }

  let operation = await ai.models.generateVideos(config);

  while (!operation.done) {
    console.log('Waiting for completion');
    // Add reassuring messages for the user during the wait
    const messages = [
        'Analyzing your prompt...',
        'Warming up the digital canvas...',
        'Composing the opening scene...',
        'Rendering keyframes...',
        'Adding final touches...',
        'Almost there, preparing your video!'
    ];
    statusEl.innerText = `Generating... (${messages[Math.floor(Math.random() * messages.length)]})`;
    await delay(10000);
    operation = await ai.operations.getVideosOperation({operation});
  }

  const videos = operation.response?.generatedVideos;
  if (videos === undefined || videos.length === 0) {
    throw new Error('No videos generated');
  }

  videos.forEach(async (v) => {
    const url = decodeURIComponent(v.video.uri);
    const res = await fetch(`${url}&key=${GEMINI_API_KEY}`);
    const blob = await res.blob();
    const objectURL = URL.createObjectURL(blob);
    video.src = objectURL;
    console.log('Loaded video into player');
    video.style.display = 'block';
    videoControlsContainer.style.display = 'flex';
  });
}

const upload = document.querySelector('#file-input') as HTMLInputElement;
const img = document.querySelector('#img') as HTMLImageElement;
let base64data = '';
let prompt = '';

upload.addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files[0];
  if (file) {
    // Reset video recording state
    resetRecordingState();

    base64data = await blobToBase64(file);
    img.src = URL.createObjectURL(file);
    img.style.display = 'block';
  }
});

const promptEl = document.querySelector('#prompt-input') as HTMLTextAreaElement;
promptEl.addEventListener('input', () => {
  prompt = promptEl.value;
});

const aspectRatioSelect =
  document.querySelector('#aspect-ratio-select') as HTMLSelectElement;
const durationInput =
  document.querySelector('#duration-input') as HTMLInputElement;
const qualitySelect =
  document.querySelector('#quality-select') as HTMLSelectElement;

let aspectRatio = '16:9';
let duration = 1;
let resolution = '720p';

aspectRatioSelect.addEventListener('change', () => {
  aspectRatio = aspectRatioSelect.value;
});

durationInput.addEventListener('change', () => {
  duration = parseInt(durationInput.value, 10);
});

qualitySelect.addEventListener('change', () => {
  resolution = qualitySelect.value;
});

const statusEl = document.querySelector('#status') as HTMLDivElement;
const video = document.querySelector('#video') as HTMLVideoElement;
const quotaErrorEl = document.querySelector('#quota-error') as HTMLDivElement;
const openKeyEl = document.querySelector('#open-key') as HTMLButtonElement;

if (window.aistudio) {
    openKeyEl.addEventListener('click', async () => {
      await window.aistudio.openSelectKey();
    });
}

const generateButton = document.querySelector(
  '#generate-button',
) as HTMLButtonElement;
const previewButton = document.querySelector(
  '#preview-button',
) as HTMLButtonElement;

generateButton.addEventListener('click', () => generate(false));
previewButton.addEventListener('click', () => generate(true));


// --- VIDEO PLAYBACK CONTROLS ---
const videoControlsContainer = document.querySelector('#video-controls-container') as HTMLDivElement;
const loopCheckbox = document.querySelector('#loop-checkbox') as HTMLInputElement;
const speedSelect = document.querySelector('#speed-select') as HTMLSelectElement;
const downloadButton = document.querySelector('#download-button') as HTMLButtonElement;

loopCheckbox.addEventListener('change', () => {
  video.loop = loopCheckbox.checked;
});

speedSelect.addEventListener('change', () => {
  video.playbackRate = parseFloat(speedSelect.value);
});

downloadButton.addEventListener('click', () => {
  // Use video.currentSrc for a more reliable check that a media resource is loaded.
  if (!video.currentSrc) {
    console.error('No video source available for download. Please generate a video first.');
    return;
  }

  const a = document.createElement('a');
  a.href = video.src;

  // Create a filename from the prompt, keeping it simple and safe.
  const safePrompt = prompt.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
  const filename = safePrompt.slice(0, 50) || 'veo-generated-video';
  a.download = `${filename}.mp4`;
  
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
});


// --- VIDEO RECORDING IMPLEMENTATION ---

const recordButton = document.querySelector('#record-button') as HTMLButtonElement;
const videoPreviewContainer = document.querySelector('#video-preview-container') as HTMLDivElement;
const videoPreview = document.querySelector('#video-preview') as HTMLVideoElement;
const recordingIndicator = document.querySelector('#recording-indicator') as HTMLDivElement;
const recordingTimer = document.querySelector('#recording-timer') as HTMLSpanElement;

const MAX_RECORDING_DURATION = 30; // seconds
const WARNING_START_TIME = 25; // seconds

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let recordedVideoBlob: Blob | null = null;
let isVideoRecording = false;
let recordingTimerInterval: number | null = null;
let recordingSeconds = 0;

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  const formattedMinutes = String(minutes).padStart(2, '0');
  const formattedSeconds = String(remainingSeconds).padStart(2, '0');
  return `${formattedMinutes}:${formattedSeconds}`;
}

function generateThumbnail(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
      const videoElement = document.createElement('video');
      const canvasElement = document.createElement('canvas');
      const context = canvasElement.getContext('2d');

      if (!context) {
          reject(new Error('Could not create canvas context.'));
          return;
      }

      // Handle video load errors
      videoElement.addEventListener('error', () => {
          URL.revokeObjectURL(videoElement.src);
          reject(new Error('Error loading video for thumbnail generation.'));
      }, { once: true });
      
      // When the video metadata is loaded, we know the duration
      videoElement.addEventListener('loadedmetadata', () => {
        // Seek to the middle of the video for a more representative frame
        videoElement.currentTime = videoElement.duration / 2;
      }, { once: true });

      // When the seek operation is complete, the frame is ready to be captured
      videoElement.addEventListener('seeked', () => {
          // Set canvas dimensions to match the video
          canvasElement.width = videoElement.videoWidth;
          canvasElement.height = videoElement.videoHeight;
          
          // Draw the current video frame onto the canvas
          context.drawImage(videoElement, 0, 0, canvasElement.width, canvasElement.height);
          
          // Get the thumbnail as a Data URL
          const dataUrl = canvasElement.toDataURL('image/png');
          
          // Clean up the object URL to prevent memory leaks
          URL.revokeObjectURL(videoElement.src);
          
          resolve(dataUrl);
      }, { once: true });

      videoElement.src = URL.createObjectURL(blob);
      videoElement.muted = true;
      videoElement.playsInline = true;
      // Trigger the loading process
      videoElement.load();
  });
}


function resetRecordingState() {
  recordedVideoBlob = null;
  videoPreviewContainer.style.display = 'none';
  videoPreview.src = '';
  videoPreview.srcObject = null;
  videoPreview.removeAttribute('controls');
  videoPreview.muted = true;
  videoPreviewContainer.classList.remove('nearing-limit');

  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  recordingIndicator.style.display = 'none';
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    
    // Reset image upload state
    img.style.display = 'none';
    img.src = '';
    base64data = '';
    upload.value = '';

    videoPreviewContainer.style.display = 'block';
    videoPreview.srcObject = stream;
    videoPreview.play();

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(track => track.stop());
      recordedVideoBlob = new Blob(recordedChunks, { type: 'video/webm' });
      videoPreview.srcObject = null;
      videoPreview.src = URL.createObjectURL(recordedVideoBlob);
      videoPreview.controls = true;
      videoPreview.muted = false;
    };

    mediaRecorder.start();
    isVideoRecording = true;
    recordButton.textContent = 'Stop Recording';
    recordButton.classList.add('recording');

    // Start timer
    recordingIndicator.style.display = 'flex';
    recordingSeconds = 0;
    recordingTimer.textContent = formatTime(recordingSeconds);
    recordingTimerInterval = window.setInterval(() => {
      recordingSeconds++;
      recordingTimer.textContent = formatTime(recordingSeconds);

      // Add visual warning when nearing the time limit
      if (recordingSeconds >= WARNING_START_TIME && recordingSeconds < MAX_RECORDING_DURATION) {
        videoPreviewContainer.classList.add('nearing-limit');
      }

      // Automatically stop recording when the time limit is reached
      if (recordingSeconds >= MAX_RECORDING_DURATION) {
        stopRecording();
      }
    }, 1000);

  } catch (err) {
    console.error('Error accessing camera:', err);
    statusEl.innerText = 'Could not access camera. Please check permissions.';
  }
}

function stopRecording() {
  if (mediaRecorder) {
    mediaRecorder.stop();
    isVideoRecording = false;
    recordButton.textContent = 'Record Video';
    recordButton.classList.remove('recording');
    videoPreviewContainer.classList.remove('nearing-limit');


    // Stop timer
    if (recordingTimerInterval) {
      clearInterval(recordingTimerInterval);
      recordingTimerInterval = null;
    }
    recordingIndicator.style.display = 'none';
  }
}

recordButton.addEventListener('click', () => {
  if (isVideoRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});


async function generate(isPreview = false) {
  // Determine settings based on preview flag
  const finalDuration = isPreview ? 1 : duration; // Preview is 1 second
  const finalResolution = isPreview ? '720p' : resolution; // Preview is standard def
  const statusGenerating = isPreview ? 'Generating preview...' : 'Generating... This may take a few minutes.';
  const statusDone = isPreview ? 'Preview ready.' : 'Done.';

  statusEl.innerText = 'Preparing...';
  video.style.display = 'none';
  videoControlsContainer.style.display = 'none';
  quotaErrorEl.style.display = 'none';
  videoEditorContainer.style.display = 'none';


  // Disable controls
  generateButton.disabled = true;
  previewButton.disabled = true;
  upload.disabled = true;
  promptEl.disabled = true;
  aspectRatioSelect.disabled = true;
  durationInput.disabled = true;
  qualitySelect.disabled = true;
  recordButton.disabled = true;

  try {
    let conditioningImageBase64 = base64data;

    if (recordedVideoBlob) {
      statusEl.innerText = 'Processing recorded video frame...';
      try {
        // We only need the base64 string for the API, not the data URL part
        const fullDataUrl = await generateThumbnail(recordedVideoBlob);
        conditioningImageBase64 = fullDataUrl.split(',')[1];
      } catch (e) {
        statusEl.innerText = 'Failed to get frame from video.';
        console.error(e);
        return; // Early exit
      }
    }

    statusEl.innerText = statusGenerating;

    await generateContent(
      prompt,
      conditioningImageBase64,
      aspectRatio,
      finalDuration,
      finalResolution,
    );
    statusEl.innerText = statusDone;
  } catch (e) {
    console.error('Video generation failed:', e);

    if (e instanceof Error) {
      if (e.message.toLowerCase().includes('network') || e.message.toLowerCase().includes('failed to fetch')) {
        statusEl.innerText = 'Network error. Please check your internet connection and try again.';
      } else {
        try {
          const match = e.message.match(/\[GoogleGenAI Error\]:\s*(.*)/);
          const errorMessage = match ? match[1] : e.message;
          const apiError = JSON.parse(errorMessage);
          if (apiError.error) {
            const { code, message } = apiError.error;
            if (code === 429) {
              quotaErrorEl.style.display = 'block';
              statusEl.innerText = '';
            } else {
              statusEl.innerText = `API Error: ${message}`;
            }
          } else {
            statusEl.innerText = e.message;
          }
        } catch (parseError) {
          statusEl.innerText = e.message;
        }
      }
    } else {
      statusEl.innerText = `An unexpected error occurred: ${String(e)}`;
    }
  } finally {
    // Re-enable controls
    generateButton.disabled = false;
    previewButton.disabled = false;
    upload.disabled = false;
    promptEl.disabled = false;
    aspectRatioSelect.disabled = false;
    durationInput.disabled = false;
    qualitySelect.disabled = false;
    recordButton.disabled = false;
  }
}

// --- VIDEO EDITING (FFMPEG) ---

const editButton = document.querySelector('#edit-button') as HTMLButtonElement;
const videoEditorContainer = document.querySelector('#video-editor-container') as HTMLDivElement;
const trimStartSlider = document.querySelector('#trim-start-slider') as HTMLInputElement;
const trimEndSlider = document.querySelector('#trim-end-slider') as HTMLInputElement;
const trimSliderRange = document.querySelector('#trim-slider-range') as HTMLDivElement;
const trimStartTimeInput = document.querySelector('#trim-start-input') as HTMLInputElement;
const trimEndTimeInput = document.querySelector('#trim-end-input') as HTMLInputElement;
const applyTrimButton = document.querySelector('#apply-trim-button') as HTMLButtonElement;
const cancelTrimButton = document.querySelector('#cancel-trim-button') as HTMLButtonElement;
const effectsSelect = document.querySelector('#effects-select') as HTMLSelectElement;
const applyEffectButton = document.querySelector('#apply-effect-button') as HTMLButtonElement;

let ffmpeg: FFmpeg | null = null;
let isEditorOpen = false;

const loadFFmpeg = async () => {
  if (ffmpeg) return;
  statusEl.innerText = 'Loading video editor...';
  ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    console.log('[FFMPEG]', message);
  });
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });
  statusEl.innerText = 'Editor loaded.';
};

function updateTrimUI() {
  const start = parseFloat(trimStartSlider.value);
  const end = parseFloat(trimEndSlider.value);
  const duration = video.duration;

  // Update numerical inputs
  trimStartTimeInput.value = start.toFixed(1);
  trimEndTimeInput.value = end.toFixed(1);

  if (isNaN(duration) || duration <= 0) return;

  // Update range visual
  const startPercent = (start / duration) * 100;
  const endPercent = (end / duration) * 100;
  trimSliderRange.style.left = `${startPercent}%`;
  trimSliderRange.style.width = `${endPercent - startPercent}%`;
}

const handleTimeUpdateForTrim = () => {
    if (!isEditorOpen) return;
    const start = parseFloat(trimStartSlider.value);
    const end = parseFloat(trimEndSlider.value);
    if (video.currentTime < start || video.currentTime > end) {
        video.currentTime = start;
    }
};

editButton.addEventListener('click', async () => {
  await loadFFmpeg();
  isEditorOpen = true;

  videoControlsContainer.style.display = 'none';
  videoEditorContainer.style.display = 'block';

  const duration = video.duration;
  trimStartSlider.step = '0.1';
  trimEndSlider.step = '0.1';
  trimStartSlider.max = duration.toString();
  trimEndSlider.max = duration.toString();
  trimStartSlider.value = '0';
  trimEndSlider.value = duration.toString();
  
  trimStartTimeInput.max = duration.toString();
  trimEndTimeInput.max = duration.toString();

  updateTrimUI();
  
  video.addEventListener('timeupdate', handleTimeUpdateForTrim);
});

cancelTrimButton.addEventListener('click', () => {
  isEditorOpen = false;
  videoEditorContainer.style.display = 'none';
  videoControlsContainer.style.display = 'flex';
  video.removeEventListener('timeupdate', handleTimeUpdateForTrim);
  effectsSelect.value = 'none';
});

trimStartSlider.addEventListener('input', () => {
  const startValue = parseFloat(trimStartSlider.value);
  const endValue = parseFloat(trimEndSlider.value);
  // Ensure the start handle does not pass the end handle.
  if (startValue >= endValue) {
    // Set the start value to be just before the end value, clamped at 0.
    const newStart = endValue - 0.1;
    trimStartSlider.value = Math.max(0, newStart).toFixed(1);
  }
  updateTrimUI();
  // Seek the video to the new start time for immediate preview.
  video.currentTime = parseFloat(trimStartSlider.value);
});

trimEndSlider.addEventListener('input', () => {
  const startValue = parseFloat(trimStartSlider.value);
  const endValue = parseFloat(trimEndSlider.value);
  // Ensure the end handle does not pass the start handle.
  if (endValue <= startValue) {
    // Set the end value to be just after the start value, clamped at the video's duration.
    const newEnd = startValue + 0.1;
    const maxDuration = parseFloat(trimEndSlider.max);
    trimEndSlider.value = Math.min(maxDuration, newEnd).toFixed(1);
  }
  updateTrimUI();
  // Seek the video to the start of the trim range to restart the preview loop.
  video.currentTime = parseFloat(trimStartSlider.value);
});

trimStartTimeInput.addEventListener('change', () => {
    let startValue = parseFloat(trimStartTimeInput.value);
    const endValue = parseFloat(trimEndSlider.value);
    const maxDuration = video.duration;

    // Clamp value to be valid
    startValue = Math.max(0, Math.min(startValue, maxDuration));
    if (startValue >= endValue) {
        startValue = Math.max(0, endValue - 0.1);
    }
    
    // Update both slider and input to the sanitized value
    trimStartSlider.value = startValue.toString();
    updateTrimUI();
    video.currentTime = startValue;
});

trimEndTimeInput.addEventListener('change', () => {
    let endValue = parseFloat(trimEndTimeInput.value);
    const startValue = parseFloat(trimStartSlider.value);
    const maxDuration = video.duration;

    // Clamp value to be valid
    endValue = Math.max(0, Math.min(endValue, maxDuration));
    if (endValue <= startValue) {
        endValue = Math.min(maxDuration, startValue + 0.1);
    }

    // Update both slider and input to the sanitized value
    trimEndSlider.value = endValue.toString();
    updateTrimUI();
    video.currentTime = startValue;
});

async function applyTrim() {
  if (!ffmpeg || !video.src) return;

  statusEl.innerText = 'Trimming video... Please wait.';
  applyTrimButton.disabled = true;
  cancelTrimButton.disabled = true;
  applyEffectButton.disabled = true;

  try {
    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';
    
    await ffmpeg.writeFile(inputFileName, await fetchFile(video.src));

    const startTime = trimStartSlider.value;
    const endTime = trimEndSlider.value;

    // Use -c copy for fast, lossless trimming
    await ffmpeg.exec(['-i', inputFileName, '-ss', startTime, '-to', endTime, '-c', 'copy', outputFileName]);
    
    const data = await ffmpeg.readFile(outputFileName);
    const newBlob = new Blob([(data as Uint8Array).buffer], { type: 'video/mp4' });
    const newUrl = URL.createObjectURL(newBlob);

    // Clean up old video source
    URL.revokeObjectURL(video.src);
    video.src = newUrl;

    statusEl.innerText = 'Trim successful!';
    cancelTrimButton.click(); // Close the editor
  } catch (error) {
    console.error('Error while trimming video:', error);
    statusEl.innerText = 'An error occurred during trimming.';
  } finally {
    applyTrimButton.disabled = false;
    cancelTrimButton.disabled = false;
    applyEffectButton.disabled = false;
  }
}

applyTrimButton.addEventListener('click', applyTrim);

async function handleApplyEffect() {
  if (!ffmpeg || !video.src) return;
  const effect = effectsSelect.value;
  if (effect === 'none') return;

  statusEl.innerText = `Applying ${effect} effect... Please wait.`;
  applyEffectButton.disabled = true;
  cancelTrimButton.disabled = true;
  applyTrimButton.disabled = true;

  try {
    const inputFileName = 'input.mp4';
    const outputFileName = 'output.mp4';
    
    await ffmpeg.writeFile(inputFileName, await fetchFile(video.src));

    const ffmpegCommand: string[] = ['-i', inputFileName];

    switch (effect) {
      case 'grayscale':
        ffmpegCommand.push('-vf', 'format=gray');
        break;
      case 'sepia':
        ffmpegCommand.push('-vf', 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
        break;
      case 'vignette':
        ffmpegCommand.push('-vf', 'vignette=PI/5');
        break;
      case 'fade': {
        const duration = video.duration;
        if (isNaN(duration) || duration < 2) {
            statusEl.innerText = 'Video is too short for a fade effect.';
            // Re-enable buttons before returning
            applyEffectButton.disabled = false;
            cancelTrimButton.disabled = false;
            applyTrimButton.disabled = false;
            return;
        }
        // Fade in for 1s, fade out for 1s at the end
        ffmpegCommand.push('-vf', `fade=t=in:st=0:d=1,fade=t=out:st=${duration - 1}:d=1`);
        break;
      }
      case 'slowmo':
        // This will double the video's duration
        ffmpegCommand.push('-vf', 'setpts=2.0*PTS');
        break;
      case 'fastforward':
        // This will halve the video's duration
        ffmpegCommand.push('-vf', 'setpts=0.5*PTS');
        break;
      default:
        throw new Error('Unknown effect selected');
    }

    ffmpegCommand.push(outputFileName);

    await ffmpeg.exec(ffmpegCommand);
    
    const data = await ffmpeg.readFile(outputFileName);
    const newBlob = new Blob([(data as Uint8Array).buffer], { type: 'video/mp4' });
    const newUrl = URL.createObjectURL(newBlob);

    // Clean up old video source and apply the new one
    URL.revokeObjectURL(video.src);
    video.src = newUrl;

    // Reset the duration-dependent UI elements in the editor after effect is applied
    video.addEventListener('loadedmetadata', () => {
      const newDuration = video.duration;
      trimStartSlider.max = newDuration.toString();
      trimEndSlider.max = newDuration.toString();
      trimStartSlider.value = '0';
      trimEndSlider.value = newDuration.toString();
      trimStartTimeInput.max = newDuration.toString();
      trimEndTimeInput.max = newDuration.toString();
      updateTrimUI();
    }, { once: true });


    statusEl.innerText = 'Effect applied successfully!';
    effectsSelect.value = 'none'; // Reset dropdown
  } catch (error) {
    console.error('Error while applying effect:', error);
    statusEl.innerText = 'An error occurred while applying the effect.';
  } finally {
    applyEffectButton.disabled = false;
    cancelTrimButton.disabled = false;
    applyTrimButton.disabled = false;
  }
}

applyEffectButton.addEventListener('click', handleApplyEffect);


// --- MY CLIPS & MERGE BIN IMPLEMENTATION ---
interface Clip {
  id?: number;
  name: string;
  blob: Blob;
  thumbnail: string;
}

const DB_NAME = 'VeoClipsDB';
const DB_VERSION = 1;
const STORE_NAME = 'clips';

let db: IDBDatabase | null = null;
let myClips: Clip[] = [];
let mergeBin: Clip[] = [];

const mergeBinContainer = document.querySelector('#merge-bin-container') as HTMLDivElement;
const mergeBinList = document.querySelector('#merge-bin-list') as HTMLDivElement;
const mergeVideosButton = document.querySelector('#merge-videos-button') as HTMLButtonElement;
const clearMergeBinButton = document.querySelector('#clear-merge-bin-button') as HTMLButtonElement;
const addToMergeBinButton = document.querySelector('#add-to-merge-bin-button') as HTMLButtonElement;
const saveClipButton = document.querySelector('#save-clip-button') as HTMLButtonElement;
const myClipsList = document.querySelector('#my-clips-list') as HTMLDivElement;


async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject("Error opening DB");
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };
  });
}

async function dbGetClips(): Promise<Clip[]> {
  const tx = db.transaction(STORE_NAME, 'readonly');
  const store = tx.objectStore(STORE_NAME);
  const request = store.getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbAddClip(clip: Omit<Clip, 'id'>): Promise<number> {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.add(clip);
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result as number);
        request.onerror = () => reject(request.error);
    });
}

async function dbUpdateClip(clip: Clip): Promise<void> {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(clip);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
}

async function dbDeleteClip(id: number): Promise<void> {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
}

function renderMyClips() {
    myClipsList.innerHTML = '';
    myClips.forEach(clip => {
        const clipEl = document.createElement('div');
        clipEl.className = 'clip-item';
        clipEl.innerHTML = `
            <img src="${clip.thumbnail}" class="clip-thumbnail" alt="${clip.name}">
            <div class="clip-info">
                <p class="clip-name">${clip.name}</p>
            </div>
            <div class="clip-actions">
                <button data-action="load">Load</button>
                <button data-action="add-merge">Add to Bin</button>
                <button data-action="rename">Rename</button>
                <button data-action="delete" class="delete-clip-btn">Delete</button>
            </div>
        `;
        myClipsList.appendChild(clipEl);
        clipEl.querySelector('[data-action="load"]').addEventListener('click', () => {
            if (clip.blob) {
                video.src = URL.createObjectURL(clip.blob);
            }
        });
        clipEl.querySelector('[data-action="add-merge"]').addEventListener('click', () => {
            addToMergeBin(clip);
        });
        clipEl.querySelector('[data-action="rename"]').addEventListener('click', async () => {
            const newName = prompt('Enter new name for the clip:', clip.name);
            if (newName && newName.trim() !== '') {
                clip.name = newName.trim();
                await dbUpdateClip(clip);
                renderMyClips();
            }
        });
        clipEl.querySelector('[data-action="delete"]').addEventListener('click', async () => {
            if (confirm(`Are you sure you want to delete "${clip.name}"?`)) {
                if (clip.id) {
                    await dbDeleteClip(clip.id);
                    myClips = myClips.filter(c => c.id !== clip.id);
                    renderMyClips();
                }
            }
        });
    });
}

function renderMergeBin() {
    mergeBinList.innerHTML = '';
    if (mergeBin.length > 0) {
        mergeBinContainer.style.display = 'block';
    } else {
        mergeBinContainer.style.display = 'none';
    }
    mergeVideosButton.disabled = mergeBin.length < 2;

    mergeBin.forEach((clip, index) => {
        const clipEl = document.createElement('div');
        clipEl.className = 'merge-clip-item';
        clipEl.innerHTML = `
            <img src="${clip.thumbnail}" alt="${clip.name}">
            <p>${clip.name}</p>
            <button class="remove-merge-clip-button" title="Remove from bin">&times;</button>
        `;
        mergeBinList.appendChild(clipEl);
        clipEl.querySelector('.remove-merge-clip-button').addEventListener('click', () => {
            mergeBin.splice(index, 1);
            renderMergeBin();
        });
    });
}

function addToMergeBin(clip: Clip) {
    mergeBin.push(clip);
    renderMergeBin();
}

addToMergeBinButton.addEventListener('click', async () => {
    if (!video.src) return;
    statusEl.innerText = 'Adding to bin...';
    try {
        const blob = await fetch(video.src).then(res => res.blob());
        const thumbnail = await generateThumbnail(blob);
        const name = `Clip ${Date.now()}`;
        addToMergeBin({ name, blob, thumbnail });
    } catch (e) {
        console.error("Failed to add video to merge bin", e);
        statusEl.innerText = 'Error adding video to bin.';
    } finally {
        statusEl.innerText = 'Added to bin.';
    }
});

saveClipButton.addEventListener('click', async () => {
    if (!video.src) return;
    const name = prompt("Enter a name for this clip:", `Clip ${new Date().toLocaleString()}`);
    if (!name || name.trim() === '') return;
    
    statusEl.innerText = 'Saving clip...';
    try {
        const blob = await fetch(video.src).then(res => res.blob());
        const thumbnail = await generateThumbnail(blob);
        const newClip: Omit<Clip, 'id'> = { name: name.trim(), blob, thumbnail };
        const id = await dbAddClip(newClip);
        myClips.push({ ...newClip, id });
        renderMyClips();
        statusEl.innerText = 'Clip saved!';
    } catch (e) {
        console.error("Failed to save clip", e);
        statusEl.innerText = 'Error saving clip.';
    }
});

clearMergeBinButton.addEventListener('click', () => {
    mergeBin = [];
    renderMergeBin();
});

mergeVideosButton.addEventListener('click', async () => {
    if (mergeBin.length < 2 || !ffmpeg) {
        statusEl.innerText = 'Add at least 2 videos to merge.';
        return;
    }

    statusEl.innerText = 'Merging videos... This may take a moment.';
    mergeVideosButton.disabled = true;

    try {
        let fileListContent = '';
        for (let i = 0; i < mergeBin.length; i++) {
            const fileName = `input${i}.mp4`;
            await ffmpeg.writeFile(fileName, await fetchFile(mergeBin[i].blob));
            fileListContent += `file '${fileName}'\n`;
        }
// FIX: `fileListContent` is a string, not a function. Removed incorrect parentheses.
        await ffmpeg.writeFile('mylist.txt', fileListContent);
        
        // Concat demuxer for merging
        await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'mylist.txt', '-c', 'copy', 'output.mp4']);
        
        const data = await ffmpeg.readFile('output.mp4');
        const newBlob = new Blob([(data as Uint8Array).buffer], { type: 'video/mp4' });
        const newUrl = URL.createObjectURL(newBlob);

        URL.revokeObjectURL(video.src);
        video.src = newUrl;
        
        statusEl.innerText = 'Merge successful!';
        mergeBin = [];
        renderMergeBin();

    } catch (error) {
        console.error('Error while merging videos:', error);
        statusEl.innerText = 'An error occurred during merging.';
    } finally {
        mergeVideosButton.disabled = false;
    }
});

// Initial Load
document.addEventListener('DOMContentLoaded', async () => {
    try {
        db = await initDB();
        myClips = await dbGetClips();
        renderMyClips();
    } catch (e) {
        console.error("Could not initialize database:", e);
        statusEl.innerText = 'Could not load saved clips.';
    }
    await loadFFmpeg();
});


// --- AGENT IMPLEMENTATION ---

declare global {
  interface AIStudio {
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    SpeechRecognition: any;
    webkitSpeechRecognition: any;
    aistudio?: AIStudio;
  }
}

const chatWindow = document.querySelector('#chat-window') as HTMLDivElement;
const agentInput = document.querySelector('#agent-input') as HTMLInputElement;
const agentSendButton = document.querySelector('#agent-send-button') as HTMLButtonElement;
const agentMicButton = document.querySelector('#agent-mic-button') as HTMLButtonElement;

const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition: any = null;
let isRecording = false;

// FIX: Added a `typeof` check to ensure `SpeechRecognitionApi` is a function before using `new`.
if (SpeechRecognitionApi && typeof SpeechRecognitionApi === 'function') {
  try {
    recognition = new SpeechRecognitionApi();
    recognition.continuous = false;
    recognition.lang = 'en-US';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      agentInput.value = transcript;
      console.log('Speech recognized:', transcript);
      sendMessage();
    };

    recognition.onerror = (event) => {
      console.error('Speech recognition error:', event.error);
      statusEl.innerText = `Speech recognition error: ${event.error}`;
    };

    recognition.onend = () => {
      isRecording = false;
      agentMicButton.classList.remove('recording');
    };
  } catch(e) {
    console.error("Speech Recognition API failed to initialize.", e);
    agentMicButton.disabled = true;
  }
} else {
  console.warn('Speech Recognition API not supported in this browser.');
  agentMicButton.disabled = true;
}

agentMicButton.addEventListener('click', () => {
  if (!recognition) return;

  if (isRecording) {
    recognition.stop();
  } else {
    try {
      recognition.start();
      isRecording = true;
      agentMicButton.classList.add('recording');
    } catch (e) {
      console.error("Could not start recognition:", e);
      statusEl.innerText = "Could not start voice recognition. Please ensure microphone permissions are granted.";
    }
  }
});

const agentAi = new GoogleGenAI({apiKey: GEMINI_API_KEY});

const tools: Record<string, (args?: any) => string | Promise<string>> = {
  setPrompt: (args: {newPrompt: string}) => {
    promptEl.value = args.newPrompt;
    prompt = args.newPrompt;
    return `Prompt set to: "${args.newPrompt}"`;
  },
  setAspectRatio: (args: {newAspectRatio: '16:9'|'9:16'|'1:1'|'4:3'|'3:4'}) => {
    aspectRatioSelect.value = args.newAspectRatio;
    aspectRatio = args.newAspectRatio;
    return `Aspect ratio set to: ${args.newAspectRatio}`;
  },
  setDuration: (args: {newDuration: number}) => {
    durationInput.value = args.newDuration.toString();
    duration = args.newDuration;
    return `Duration set to: ${args.newDuration} seconds`;
  },
  setQuality: (args: {newQuality: 'standard'|'high'}) => {
    const qualityMap = {
      standard: '720p',
      high: '1080p',
    };
    const newResolution = qualityMap[args.newQuality];
    qualitySelect.value = newResolution;
    resolution = newResolution;
    return `Video quality set to: ${args.newQuality} (${newResolution})`;
  },
  clickGenerate: () => {
    generate();
    return 'Starting video generation...';
  },
  openEditor: () => {
    if (!video.src || video.src.startsWith('blob:') === false) {
        return "A video must be generated or loaded before you can open the editor.";
    }
    if (isEditorOpen) {
        return "The editor is already open.";
    }
    editButton.click();
    return "Video editor opened.";
  },
  closeEditor: () => {
      if (!isEditorOpen) {
          return "The editor is already closed.";
      }
      cancelTrimButton.click();
      return "Video editor closed.";
  },
  trimVideo: async (args: { startTime: number, endTime: number }) => {
      if (!isEditorOpen) {
          return 'Please open the editor first before trimming.';
      }
      const duration = video.duration;
      if (isNaN(duration) || args.startTime >= args.endTime || args.startTime < 0 || args.endTime > duration) {
          return `Invalid trim times. Start time must be less than end time and within the video bounds (0-${duration.toFixed(1)}s).`;
      }
      trimStartSlider.value = args.startTime.toString();
      trimEndSlider.value = args.endTime.toString();
      updateTrimUI();
      await applyTrim();
      return `Video trimmed successfully.`;
  },
  applyEffect: async (args: { effectName: string }) => {
      if (!isEditorOpen) {
          return 'Please open the editor first before applying effects.';
      }
      const validEffects = Array.from(effectsSelect.options).map(o => o.value).filter(v => v !== 'none');
      if (!validEffects.includes(args.effectName)) {
          return `Invalid effect. Please choose from: ${validEffects.join(', ')}.`;
      }
      effectsSelect.value = args.effectName;
      await handleApplyEffect();
      return `Applied the ${args.effectName} effect successfully.`;
  },
};

const toolDefinitions: Tool = {
    functionDeclarations: [
        {
          name: 'setPrompt',
          description: 'Sets the text prompt for the video generation.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              newPrompt: { type: Type.STRING, description: 'The text prompt to use.' },
            },
            required: ['newPrompt'],
          },
        },
        {
          name: 'setAspectRatio',
          description: 'Sets the aspect ratio of the video.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              newAspectRatio: { type: Type.STRING, enum: ['16:9', '9:16', '1:1', '4:3', '3:4'], description: 'The desired aspect ratio.' },
            },
            required: ['newAspectRatio'],
          },
        },
        {
          name: 'setDuration',
          description: 'Sets the duration of the video in seconds.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              newDuration: { type: Type.NUMBER, description: 'The duration in seconds.' },
            },
            required: ['newDuration'],
          },
        },
        {
          name: 'setQuality',
          description: 'Sets the quality of the video.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              newQuality: { type: Type.STRING, enum: ['standard', 'high'], description: 'The desired video quality.' },
            },
            required: ['newQuality'],
          },
        },
        {
            name: 'clickGenerate',
            description: 'Starts the video generation process with the current settings.',
            parameters: {
                type: Type.OBJECT,
                properties: {},
            }
        },
        {
          name: 'openEditor',
          description: 'Opens the video editor to enable trimming and effects. A video must be present.',
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: 'closeEditor',
          description: 'Closes the video editor.',
          parameters: { type: Type.OBJECT, properties: {} },
        },
        {
          name: 'trimVideo',
          description: 'Trims the video to a specified start and end time. The editor must be open.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              startTime: { type: Type.NUMBER, description: 'The start time in seconds.' },
              endTime: { type: Type.NUMBER, description: 'The end time in seconds.' },
            },
            required: ['startTime', 'endTime'],
          },
        },
        {
          name: 'applyEffect',
          description: 'Applies a visual effect to the video. The editor must be open.',
          parameters: {
            type: Type.OBJECT,
            properties: {
              effectName: {
                type: Type.STRING,
                enum: ['grayscale', 'sepia', 'vignette', 'fade', 'slowmo', 'fastforward'],
                description: 'The name of the effect to apply.',
              },
            },
            required: ['effectName'],
          },
        },
    ],
};

const chat: Chat = agentAi.chats.create({
  model: 'gemini-2.5-flash',
  config: {
    tools: [toolDefinitions],
    systemInstruction: `You are a helpful and creative AI assistant for video generation and editing.
- Your goal is to help the user configure, generate, and edit a video based on their requests.
- You can control the generation settings (prompt, aspect ratio, duration, quality) by calling the available tools. Once the user is happy, call the \`clickGenerate\` tool.
- For video quality, 'standard' maps to 720p and 'high' maps to 1080p.
- You can also control the video editor. A video must be generated or loaded before editing.
- To edit, you must first open the editor with the \`openEditor\` tool. You can close it with \`closeEditor\`.
- Once the editor is open, you can trim using \`trimVideo({startTime, endTime})\` or apply effects with \`applyEffect({effectName})\`.
- For effects, map user requests like 'make it black and white' to 'grayscale', 'make it look old' to 'sepia', 'add a fade' to 'fade', 'slow it down' to 'slowmo', or 'speed it up' to 'fastforward'.
- Always confirm that a video is present before attempting to open the editor or apply edits. Inform the user if no video is loaded.
- Be friendly, proactive, and guide the user. After calling a tool, confirm what you have done. For example: "OK, I've set the prompt to 'a cat riding a skateboard'" or "Applied the grayscale filter."`,
  },
});

function addMessage(text: string, sender: 'user' | 'agent' | 'tool') {
  const messageEl = document.createElement('div');
  messageEl.classList.add('message', `${sender}-message`);
  messageEl.textContent = text;
  chatWindow.appendChild(messageEl);
  chatWindow.scrollTop = chatWindow.scrollHeight;
}

async function sendMessage() {
    const userInput = agentInput.value.trim();
    if (!userInput) return;

    addMessage(userInput, 'user');
    agentInput.value = '';
    agentSendButton.disabled = true;

    try {
        let response: GenerateContentResponse = await chat.sendMessage({ message: userInput });

        while (response.candidates && response.candidates[0].content.parts.some(part => part.functionCall)) {
            const functionCallPart = response.candidates[0].content.parts.find(part => part.functionCall);
            if (!functionCallPart || !functionCallPart.functionCall) break;

            const { name, args } = functionCallPart.functionCall;
            const tool = tools[name];

            if (tool) {
                const toolResult = await (tool as any)(args);
                addMessage(`🤖 Tool call: ${name}(${JSON.stringify(args)})`, 'tool');

                response = await chat.sendMessage({
                  message: [
                    {
                      functionResponse: { name, response: { content: toolResult } },
                    },
                  ],
                });
            } else {
                addMessage(`Error: Unknown tool "${name}"`, 'agent');
                break;
            }
        }
        
// FIX: The `.text` property on GenerateContentResponse is a string, not a function.
        addMessage(response.text, 'agent');
    } catch (error) {
        console.error("Agent chat error:", error);
        addMessage("Sorry, I encountered an error. Please try again.", 'agent');
    } finally {
        agentSendButton.disabled = false;
    }
}

agentSendButton.addEventListener('click', sendMessage);
agentInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendMessage();
  }
});

// Initialize prompt from textarea
prompt = promptEl.value;
