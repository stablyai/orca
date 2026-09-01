import { ipcRenderer } from 'electron'

export const macosTccPromptsApi = {
  onThreshold: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void =>
      callback(payload)
    ipcRenderer.on('macosTccPrompts:threshold', listener)
    return () => ipcRenderer.removeListener('macosTccPrompts:threshold', listener)
  },
  consumePending: (): Promise<{ claimId: number; promptCount: number } | null> =>
    ipcRenderer.invoke('macosTccPrompts:consumePending'),
  acknowledgePending: (claimId: number): Promise<void> =>
    ipcRenderer.invoke('macosTccPrompts:acknowledgePending', claimId),
  releasePending: (claimId: number): Promise<void> =>
    ipcRenderer.invoke('macosTccPrompts:releasePending', claimId),
  dismiss: (): Promise<void> => ipcRenderer.invoke('macosTccPrompts:dismiss')
}
