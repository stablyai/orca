import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { ExternalEditorRequest, ExternalEditorResponse } from '../../shared/external-editor'

export const uiExternalEditorApi = {
  onExternalEditorRequest: (callback: (request: ExternalEditorRequest) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, request: ExternalEditorRequest): void =>
      callback(request)
    ipcRenderer.on('ui:externalEditorRequest', listener)
    return () => ipcRenderer.removeListener('ui:externalEditorRequest', listener)
  },
  onExternalEditorCancel: (callback: (requestId: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, requestId: string): void =>
      callback(requestId)
    ipcRenderer.on('ui:externalEditorCancel', listener)
    return () => ipcRenderer.removeListener('ui:externalEditorCancel', listener)
  },
  respondExternalEditor: (response: ExternalEditorResponse) =>
    ipcRenderer.send('ui:externalEditorResponse', response)
} satisfies Partial<PreloadApi['ui']>
