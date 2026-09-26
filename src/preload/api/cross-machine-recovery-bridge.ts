import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { CrossMachineRecoveryPickupProgressEvent } from '../../shared/cross-machine-recovery-provider-ipc'

const getClientInstanceId = (): Promise<string> =>
  ipcRenderer.invoke('crossMachineRecovery:getClientInstanceId')

async function invokeAsClient<T>(channel: string, args: object): Promise<T> {
  return ipcRenderer.invoke(channel, { ...args, clientInstanceId: await getClientInstanceId() })
}

export const crossMachineRecoveryApi = {
  isSupported: true,
  getClientInstanceId,
  status: () => invokeAsClient('crossMachineRecovery:status', {}),
  list: (args = {}) => invokeAsClient('crossMachineRecovery:list', args),
  inspect: (args) => invokeAsClient('crossMachineRecovery:inspect', args),
  pickup: (args) => invokeAsClient('crossMachineRecovery:pickup', args),
  cancel: (operationId) => ipcRenderer.invoke('crossMachineRecovery:cancel', { operationId }),
  onPickupProgress: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: CrossMachineRecoveryPickupProgressEvent
    ): void => listener(payload)
    ipcRenderer.on('crossMachineRecovery:pickupProgress', handler)
    return () => {
      ipcRenderer.removeListener('crossMachineRecovery:pickupProgress', handler)
    }
  }
} satisfies PreloadApi['crossMachineRecovery']
