// Why: cap execFile output to prevent an uncatchable V8 string overflow; match relay MAX_GIT_BUFFER.
export const DEFAULT_GIT_MAX_BUFFER = 10 * 1024 * 1024

// Why: the admission tier is a wire value, so it is declared with its params schema.
import type { GitAdmissionTier } from '../../../shared/rpc-contract/git-admission-tier-params'

export type { GitAdmissionTier }

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
  wslDistro?: string
  preferWslDirectGit?: boolean
  useConfiguredSshCommandForNetwork?: boolean
  terminationBarrier?: boolean
  captureWslLoginShellOutput?: boolean
  /** Scheduler priority for this child; status is the safe default. */
  admissionTier?: GitAdmissionTier
}
