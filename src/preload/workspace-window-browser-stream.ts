import type { IpcRenderer } from 'electron'
const { ipcRenderer } = require('electron') as { ipcRenderer: IpcRenderer }
import type { WorkspaceWindowNativeBridge } from './api/workspace-window-native-api'
let nextStreamId = 0

export const subscribeWorkspaceWindowBrowser: WorkspaceWindowNativeBridge['subscribeBrowser'] =
  async (request, callbacks) => {
    const id = String(++nextStreamId)
    const listener = (_event: unknown, event: { id: string; kind: string; data: never }): void => {
      if (event.id !== id) {
        return
      }
      if (event.kind === 'response') {
        callbacks.onResponse(event.data)
      }
      if (event.kind === 'binary') {
        callbacks.onBinary?.(event.data)
      }
      if (event.kind === 'error') {
        callbacks.onError?.(event.data)
      }
      if (event.kind === 'close') {
        removeListener()
        callbacks.onClose?.()
      }
    }
    const removeListener = (): void => {
      ipcRenderer.removeListener('workspaceWindow:browserStream:event', listener)
    }
    ipcRenderer.on('workspaceWindow:browserStream:event', listener)
    try {
      const started = await ipcRenderer.invoke('workspaceWindow:browserStream:start', id, request)
      if (!started) {
        removeListener()
        return null
      }
      return {
        sendBinary: () => {},
        unsubscribe: () => {
          removeListener()
          void ipcRenderer.invoke('workspaceWindow:browserStream:stop', id)
        }
      }
    } catch (error) {
      removeListener()
      throw error
    }
  }
