// Bound output to avoid V8 string overflow; match the relay's MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'

export type GitExecOptions = {
  cwd: string
  encoding?: BufferEncoding | 'buffer'
  maxBuffer?: number
  timeout?: number
  /** Overrides only the default read deadline in tests; explicit timeout still wins. */
  timeoutMsForTest?: number
  stdin?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Cancels admission only; a running child still finishes. */
  admissionSignal?: AbortSignal
  /** Rechecks owner eligibility after admission, before starting the child. */
  canStart?: () => boolean
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project (local-git-runtime-route.ts); say why. */
  hostGit?: true
  preferWslDirectGit?: boolean
  useConfiguredSshCommandForNetwork?: boolean
  terminationBarrier?: boolean
  observeChildTermination?: (terminated: Promise<void>, writes: boolean) => void
  /** Scheduler priority for this child; status is the safe default. */
  admissionTier?: GitAdmissionTier
  /** File materialization during worktree creation has a separate concurrency budget. */
  admissionClass?: 'checkout'
  /** Skips general admission; only for a caller that bounds its own concurrency (worktree deletes). */
  admissionExempt?: true
  /** Native macOS deletion spawns use the shared process worker. */
  spawnOnWorkerThread?: boolean
  /** Observe stderr without changing capture/errors; incompatible with terminationBarrier. */
  onStderr?: (chunk: string) => void
}
