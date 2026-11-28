import type { GitAdmissionTier } from '../../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  readDefaultBaseRefViaExec,
  resolveDefaultBaseRefViaExec,
  type GitExec
} from '../../../../shared/git/refs/git-default-base-ref'

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  /** Checked at admission; a bounded optional read refuses git that would start past its deadline. */
  canStart?: () => boolean
}

export type LocalDefaultBaseRefGitOptions = {
  cwd: string
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  canStart?: () => boolean
}

export const DEFAULT_BASE_REF_PROBE_TIMEOUT_MS = 15_000

export function gitExecOptions(
  cwd: string,
  options: LocalGitExecOptions = {}
): LocalDefaultBaseRefGitOptions {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {}),
    ...(options.canStart ? { canStart: options.canStart } : {})
  }
}

function defaultBaseRefProbeExec(options: LocalDefaultBaseRefGitOptions): GitExec {
  return (argv) =>
    gitExecFileAsync(argv, { ...options, timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS })
}

/** Rejects when Git fails or times out, so callers can tell that apart from no default base. */
export function readDefaultBaseRefWithLocalGit(
  options: LocalDefaultBaseRefGitOptions
): Promise<string | null> {
  return readDefaultBaseRefViaExec(defaultBaseRefProbeExec(options))
}

export function resolveDefaultBaseRefWithLocalGit(
  options: LocalDefaultBaseRefGitOptions
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec(defaultBaseRefProbeExec(options))
}

export function getDefaultBaseRefAsync(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefWithLocalGit(gitExecOptions(path, options))
}
