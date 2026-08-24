import type { IpcRenderer } from 'electron'
import type { OrcaBackgroundApi } from './api/orca-background-api'

type OrcaBackgroundIpc = Pick<IpcRenderer, 'invoke'>

export function createOrcaBackgroundApi(ipcRenderer: OrcaBackgroundIpc): OrcaBackgroundApi {
  return {
    listLibrary: () => ipcRenderer.invoke('backgrounds:listLibrary'),
    addImages: () => ipcRenderer.invoke('backgrounds:addImages'),
    openLibrary: () => ipcRenderer.invoke('backgrounds:openLibrary'),
    loadImage: (fileName) => ipcRenderer.invoke('backgrounds:loadImage', fileName)
  }
}
