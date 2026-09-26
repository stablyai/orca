import { ipcRenderer } from 'electron'
import {
  CROSS_MACHINE_RECOVERY_APPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_APPLY_REPLY_CHANNEL,
  CROSS_MACHINE_RECOVERY_RESUME_LOCAL_CHANNEL,
  type CrossMachineRecoveryApplyRequest
} from '../../shared/cross-machine-recovery-session-ops'
import type { PreloadApi } from '../api-types'

export const crossMachineRecoveryApi = {
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
