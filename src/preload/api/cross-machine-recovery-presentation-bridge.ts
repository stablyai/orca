import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'

export const crossMachineRecoveryPresentationApi = {
  publishLocal: (params) =>
    ipcRenderer.invoke('crossMachineRecovery:publishPresentationLocal', params),
  getClientInstanceId: () => ipcRenderer.invoke('crossMachineRecovery:getClientInstanceId'),
  getClientName: () => ipcRenderer.invoke('crossMachineRecovery:getClientName')
} satisfies PreloadApi['crossMachineRecoveryPresentation']
