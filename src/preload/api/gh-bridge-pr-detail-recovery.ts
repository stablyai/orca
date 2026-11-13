import { ipcRenderer } from 'electron'
import type {
  PRDetailRecoveryCancelArgs,
  PRDetailRecoveryCommitArgs,
  PRDetailRecoveryStartArgs,
  PRDetailRecoveryWaitArgs
} from '../../shared/github/pull-requests/refresh/pr-detail-recovery-contract'

export const ghPRDetailRecoveryApi = {
  startPRDetailRecovery: (args: PRDetailRecoveryStartArgs) =>
    ipcRenderer.invoke('gh:startPRDetailRecovery', args),
  waitPRDetailRecovery: (args: PRDetailRecoveryWaitArgs) =>
    ipcRenderer.invoke('gh:waitPRDetailRecovery', args),
  commitPRDetailRecovery: (args: PRDetailRecoveryCommitArgs) =>
    ipcRenderer.invoke('gh:commitPRDetailRecovery', args),
  cancelPRDetailRecovery: (args: PRDetailRecoveryCancelArgs) =>
    ipcRenderer.invoke('gh:cancelPRDetailRecovery', args)
}
