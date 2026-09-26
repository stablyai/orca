import { ipcRenderer } from 'electron'
import {
  CROSS_MACHINE_RECOVERY_APPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_RELEASE_LOCAL_CHANNEL,
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryApplyRequest
} from '../../shared/cross-machine-recovery-session-ops'
import type { PreloadApi } from '../api-types'
import type { CrossMachineRecoveryPickupProgressEvent } from '../../shared/cross-machine-recovery-provider-ipc'

export const crossMachineRecoveryApi = {
  isSupported: true,
  status: () => ipcRenderer.invoke('crossMachineRecovery:status'),
  list: (args = {}) => ipcRenderer.invoke('crossMachineRecovery:list', args),
  inspect: (args) => ipcRenderer.invoke('crossMachineRecovery:inspect', args),
  // Why: invoked synchronously so main registers the operation before any cancel can reach it.
  pickup: (args) => ipcRenderer.invoke('crossMachineRecovery:pickup', args),
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
  resumeLocal: (args) => ipcRenderer.invoke(CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL, args),
  releaseLocal: (args) => ipcRenderer.invoke(CROSS_MACHINE_RECOVERY_RELEASE_LOCAL_CHANNEL, args)
} satisfies PreloadApi['crossMachineRecovery']
