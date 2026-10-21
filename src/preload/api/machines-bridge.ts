import { ipcRenderer } from 'electron'
import type { MachineProviderSnapshot } from '../../shared/machine-inventory'
import type { PreloadApi } from '../api-types'

export const machinesApi = {
  snapshots: () => ipcRenderer.invoke('machines:snapshots'),
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
  }
} satisfies PreloadApi['machines']
