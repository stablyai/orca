import { ipcRenderer } from 'electron'
import type {
  RuntimeDownloadProgressEvent,
  RuntimeDownloadResult,
  RuntimeDownloadStartArgs
} from '../../shared/runtime-downloads/runtime-download-contract'

export type RuntimeDownloadsApi = {
  /** Resolves when the download finishes, fails or is canceled. */
  start: (args: RuntimeDownloadStartArgs) => Promise<RuntimeDownloadResult>
  cancel: (args: { downloadId: string }) => Promise<{ canceled: boolean }>
  onProgress: (callback: (event: RuntimeDownloadProgressEvent) => void) => () => void
}

export const runtimeDownloadsApi: RuntimeDownloadsApi = {
  start: (args) => ipcRenderer.invoke('runtimeDownloads:start', args),
  cancel: (args) => ipcRenderer.invoke('runtimeDownloads:cancel', args),
  onProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: RuntimeDownloadProgressEvent) =>
      callback(payload)
    ipcRenderer.on('runtimeDownloads:progress', listener)
    return () => ipcRenderer.removeListener('runtimeDownloads:progress', listener)
  }
}
