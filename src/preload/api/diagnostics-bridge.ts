import { ipcRenderer } from 'electron'

export const diagnosticsApi = {
  getStatus: (): Promise<unknown> => ipcRenderer.invoke('diagnostics:getStatus'),
  collectBundle: (lookbackMinutes?: number): Promise<unknown> =>
    ipcRenderer.invoke('diagnostics:collectBundle', lookbackMinutes),
  openBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:openBundlePreview', bundleSubmissionId),
  discardBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:discardBundlePreview', bundleSubmissionId),
  uploadBundle: (bundleSubmissionId: string): Promise<unknown> =>
    ipcRenderer.invoke('diagnostics:uploadBundle', bundleSubmissionId),
  deleteBundle: (ticketId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:deleteBundle', ticketId)
}
