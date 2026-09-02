import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const macosTccPromptsApi = {
  onThreshold: (callback: (payload: { promptCount: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { promptCount: number }): void =>
      callback(payload)
    ipcRenderer.on('macosTccPrompts:threshold', listener)
    return (): void => {
      ipcRenderer.removeListener('macosTccPrompts:threshold', listener)
    }
  },
  consumePending: (): Promise<{ claimId: number; promptCount: number } | null> =>
    ipcRenderer.invoke('macosTccPrompts:consumePending'),
  acknowledgePending: (claimId: number): Promise<void> =>
    ipcRenderer.invoke('macosTccPrompts:acknowledgePending', claimId),
  releasePending: (claimId: number): Promise<void> =>
    ipcRenderer.invoke('macosTccPrompts:releasePending', claimId),
  dismiss: (): Promise<void> => ipcRenderer.invoke('macosTccPrompts:dismiss')
} satisfies PreloadApi['macosTccPrompts']
