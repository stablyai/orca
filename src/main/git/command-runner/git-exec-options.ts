// Bound output to avoid V8 string overflow; match the relay's MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'

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
  /** Like canStart, awaited once admitted; it must not run Git itself, which could wait on this slot. */
  beforeStart?: () => Promise<boolean>
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

export type GitBufferExecOptions = {
  cwd: string
  maxBuffer?: number
  timeout?: number
  timeoutMsForTest?: number
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  preferWslDirectGit?: boolean
  admissionTier?: GitAdmissionTier
  signal?: AbortSignal
  stdin?: string
}

/** Result of a streamed git command; `stoppedEarly` is true when onStdout asked to stop before the child exited. */
export type GitStreamResult = { stoppedEarly: boolean }

export type GitStreamOptions = {
  cwd: string
  env?: NodeJS.ProcessEnv
  wslDistro?: string
  /** Runs the host's Git even in a WSL-runtime project (local-git-runtime-route.ts); say why. */
  hostGit?: true
  preferWslDirectGit?: boolean
  signal?: AbortSignal
  /** Byte backstop; defaults to DEFAULT_GIT_MAX_BUFFER. */
  maxBuffer?: number
  /** Independent stderr cap for parsers that stream an arbitrarily large population. */
  maxStderrBuffer?: number
  /** Explicit wall-clock deadline; read commands default to the production backstop. */
  timeoutMs?: number
  /** Overrides only the default read deadline in tests. */
  timeoutMsForTest?: number
  admissionTier?: GitAdmissionTier
  /** Return true to kill the child and resolve with stoppedEarly=true. */
  onStdout: (chunk: string) => boolean | void
}
