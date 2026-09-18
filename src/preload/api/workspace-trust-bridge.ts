import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const workspaceTrustApi = {
  resolveIntake: (args) => ipcRenderer.invoke('workspaceTrust:resolveIntake', args),
  decide: (args) => ipcRenderer.invoke('workspaceTrust:decide', args),
  revoke: (args) => ipcRenderer.invoke('workspaceTrust:revoke', args)
} satisfies PreloadApi['workspaceTrust']
