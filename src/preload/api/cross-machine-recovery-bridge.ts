import { ipcRenderer } from 'electron'
import {
  CROSS_MACHINE_RECOVERY_APPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryApplyRequest
} from '../../shared/cross-machine-recovery-session-ops'
import type { PreloadApi } from '../api-types'
import type {
  CrossMachineRecoveryInspectArgs,
  CrossMachineRecoveryListArgs,
  CrossMachineRecoveryPickupArgs,
  CrossMachineRecoveryPickupProgressEvent
} from '../../shared/cross-machine-recovery-provider-ipc'

type ProviderCallArgs =
  | CrossMachineRecoveryListArgs
  | CrossMachineRecoveryInspectArgs
  | CrossMachineRecoveryPickupArgs

const getClientInstanceId = (): Promise<string> =>
  ipcRenderer.invoke('crossMachineRecovery:getClientInstanceId')

async function invokeAsClient<T>(channel: string, args: ProviderCallArgs): Promise<T> {
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
  },
  onApply: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: CrossMachineRecoveryApplyRequest
    ) => callback(request)
    ipcRenderer.on(CROSS_MACHINE_RECOVERY_APPLY_CHANNEL, listener)
    return () => ipcRenderer.removeListener(CROSS_MACHINE_RECOVERY_APPLY_CHANNEL, listener)
  },
  reply: (reply) => ipcRenderer.send(CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL, reply),
  resumeLocal: (args) => ipcRenderer.invoke(CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL, args)
} satisfies PreloadApi['crossMachineRecovery']
