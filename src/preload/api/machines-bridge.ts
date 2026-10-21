import { ipcRenderer } from 'electron'
import type {
  MachineExpiryWarning,
  MachineProgressEvent,
  MachineProviderSnapshot
} from '../../shared/machine-inventory'
import type { PreloadApi } from '../api-types'

export const machinesApi = {
  snapshots: () => ipcRenderer.invoke('machines:snapshots'),
  expiryWarnings: () => ipcRenderer.invoke('machines:expiryWarnings'),
  workAtRisk: (args) => ipcRenderer.invoke('machines:workAtRisk', args),
  onExpiryWarning: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, warning: MachineExpiryWarning): void =>
      callback(warning)
    ipcRenderer.on('machines:expiryWarning', listener)
    return () => ipcRenderer.removeListener('machines:expiryWarning', listener)
  },
  list: (args) => ipcRenderer.invoke('machines:list', args),
  get: (args) => ipcRenderer.invoke('machines:get', args),
  create: (args) => ipcRenderer.invoke('machines:create', args),
  cancelCreate: (args) => ipcRenderer.invoke('machines:cancelCreate', args),
  sleep: (args) => ipcRenderer.invoke('machines:sleep', args),
  wake: (args) => ipcRenderer.invoke('machines:wake', args),
  archive: (args) => ipcRenderer.invoke('machines:archive', args),
  delete: (args) => ipcRenderer.invoke('machines:delete', args),
  connect: (args) => ipcRenderer.invoke('machines:connect', args),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: MachineProviderSnapshot): void =>
      callback(snapshot)
    ipcRenderer.on('machines:changed', listener)
    return () => ipcRenderer.removeListener('machines:changed', listener)
  },
  onProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: MachineProgressEvent): void =>
      callback(event)
    ipcRenderer.on('machines:progress', listener)
    return () => ipcRenderer.removeListener('machines:progress', listener)
  }
} satisfies PreloadApi['machines']
