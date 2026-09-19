import { ipcRenderer } from 'electron'
import type { CustomCssSnapshot } from '../../shared/custom-css'
import type { PreloadApi } from '../api-types'

export const customCssApi = {
  get: (): Promise<CustomCssSnapshot> => ipcRenderer.invoke('customCss:get'),
  openFile: (): Promise<CustomCssSnapshot> => ipcRenderer.invoke('customCss:openFile'),
  revealFile: (): Promise<CustomCssSnapshot> => ipcRenderer.invoke('customCss:revealFile'),
  onChanged: (callback: (snapshot: CustomCssSnapshot) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: CustomCssSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('customCss:changed', listener)
    return () => ipcRenderer.removeListener('customCss:changed', listener)
  }
} satisfies PreloadApi['customCss']
