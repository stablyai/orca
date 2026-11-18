import { ipcRenderer } from 'electron'
import {
  BACKGROUND_WORKER_PAUSED_CHANNEL,
  BACKGROUND_WORKER_RETRY_CHANNEL
} from '../../../shared/background-worker/background-worker-pause-channels'

export type BackgroundWorkerApi = {
  onPaused: (callback: () => void) => () => void
  retry: () => Promise<void>
}

export const backgroundWorkerApi: BackgroundWorkerApi = {
  onPaused: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(BACKGROUND_WORKER_PAUSED_CHANNEL, listener)
    return () => ipcRenderer.removeListener(BACKGROUND_WORKER_PAUSED_CHANNEL, listener)
  },
  retry: () => ipcRenderer.invoke(BACKGROUND_WORKER_RETRY_CHANNEL)
}
