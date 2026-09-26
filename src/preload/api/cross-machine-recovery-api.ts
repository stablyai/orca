import type { RecoveryResumeResult } from '../../shared/cross-machine-recovery-descriptor'
import type {
  CrossMachineRecoveryApplyReply,
  CrossMachineRecoveryApplyRequest,
  CrossMachineRecoveryReleaseLocalResult,
  CrossMachineRecoveryResumeLocalArgs
} from '../../shared/cross-machine-recovery-session-ops'
import type { CrossMachineRecoveryProviderApi } from '../../shared/cross-machine-recovery-provider-ipc'

export type CrossMachineRecoveryApi = CrossMachineRecoveryProviderApi & {
  /** Host-authored session writes; the renderer applies and persists each before replying. */
  onApply: (callback: (request: CrossMachineRecoveryApplyRequest) => void) => () => void
  reply: (reply: CrossMachineRecoveryApplyReply) => void
  /** Resumes a dormant recovered session through this computer's local runtime, never a remote one. */
  resumeLocal: (args: CrossMachineRecoveryResumeLocalArgs) => Promise<RecoveryResumeResult>
  /** "Start shell instead": consumes the dormant binding so its pane may start a plain shell. */
  releaseLocal: (
    args: CrossMachineRecoveryResumeLocalArgs
  ) => Promise<CrossMachineRecoveryReleaseLocalResult>
}
