import type { ExecFileOptions } from 'node:child_process'
import type { WorktreeCheckoutSpawnGuard } from '../../../../shared/worktree/removal/worktree-checkout-identity'
import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'

export type ExecFileCaptureOptions = Omit<ExecFileOptions, 'timeout'> & {
  timeout?: number
  stdin?: string
  terminationBarrier?: boolean
  /** Normal close or proven termination; mutation fences wait for this. */
  onChildTerminated?: () => void
  /** The child's worker died before its end was proven: capacity such as Git admission may return, fences may not. */
  onWorkerLost?: () => void
  /** The caller holds no mutation fence, so a lost worker ends the child's lifetime without proof (implied without onChildTerminated). */
  workerLossEndsLifetime?: boolean
  admissionTier?: GitAdmissionTier
  createTimeoutError?: () => Error
  /** Called once when the deadline — not an abort — is what ended the process. */
  onDeadlineKill?: () => void
  onStderr?: (chunk: string) => void
  /** False keeps a Windows launch on main; true waits for a cold worker instead of spawning on main meanwhile. */
  spawnOnWorkerThread?: boolean
  worktreeCheckoutGuard?: WorktreeCheckoutSpawnGuard
  /** Native Git only: launch an owned group and retain it after abnormal stop until proof. */
  ownedPosixGroup?: boolean
  /** Rechecked synchronously at the spawn call, after any async executable resolution (so it keeps POSIX launches on main). */
  canStart?: () => boolean
}
