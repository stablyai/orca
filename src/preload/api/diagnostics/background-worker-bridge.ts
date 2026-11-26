import { ipcRenderer } from 'electron'
import {
  BACKGROUND_WORKER_IS_PAUSED_CHANNEL,
  BACKGROUND_WORKER_PAUSED_CHANNEL,
  BACKGROUND_WORKER_RESUMED_CHANNEL,
  BACKGROUND_WORKER_RETRY_CHANNEL
} from '../../../shared/background-worker/background-worker-pause-channels'
import type { BackgroundWorkerApi } from './background-worker-api'

function subscribe(channel: string, callback: () => void): () => void {
  const listener = (): void => callback()
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

export const backgroundWorkerApi: BackgroundWorkerApi = {
  onPaused: (callback) => subscribe(BACKGROUND_WORKER_PAUSED_CHANNEL, callback),
  onResumed: (callback) => subscribe(BACKGROUND_WORKER_RESUMED_CHANNEL, callback),
  isPaused: () => ipcRenderer.invoke(BACKGROUND_WORKER_IS_PAUSED_CHANNEL),
  retry: () => ipcRenderer.invoke(BACKGROUND_WORKER_RETRY_CHANNEL)
}
