import { contextBridge, ipcRenderer } from 'electron'

// Why: the modal HTML calls window.electronAPI.submitPassphrase to deliver the
// entered value (or null on cancel) back to the main process. We expose only
// this one IPC channel to keep the modal's attack surface tiny.
contextBridge.exposeInMainWorld('electronAPI', {
  submitPassphrase: (value: string | null): void => {
    void ipcRenderer.invoke('claude-accounts:passphrase-submitted', value)
  }
})
