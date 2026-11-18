import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const googleSetupApi = {
  pickClientFile: () => ipcRenderer.invoke('googleSetup:pickClientFile'),
  saveAppFile: (args) => ipcRenderer.invoke('googleSetup:saveAppFile', args),
  watchDownloads: () => ipcRenderer.invoke('googleSetup:watchDownloads'),
  stopWatchingDownloads: () => ipcRenderer.invoke('googleSetup:stopWatchingDownloads'),
  findDownloadedKey: (args) => ipcRenderer.invoke('googleSetup:findDownloadedKey', args)
} satisfies PreloadApi['googleSetup']
