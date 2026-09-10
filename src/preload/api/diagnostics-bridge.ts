import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const diagnosticsApi = {
  providerResourceEnabled: process.env.ORCA_PROVIDER_RESOURCE_DIAGNOSTICS === '1',
  observeProviderResource: (args) =>
    ipcRenderer.invoke('diagnostics:observeProviderResource', args),
  getStatus: () => ipcRenderer.invoke('diagnostics:getStatus'),
  collectBundle: (lookbackMinutes?: number) =>
    ipcRenderer.invoke('diagnostics:collectBundle', lookbackMinutes),
  openBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:openBundlePreview', bundleSubmissionId),
  discardBundlePreview: (bundleSubmissionId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:discardBundlePreview', bundleSubmissionId),
  uploadBundle: (bundleSubmissionId: string) =>
    ipcRenderer.invoke('diagnostics:uploadBundle', bundleSubmissionId),
  deleteBundle: (ticketId: string): Promise<void> =>
    ipcRenderer.invoke('diagnostics:deleteBundle', ticketId)
} satisfies PreloadApi['diagnostics']
