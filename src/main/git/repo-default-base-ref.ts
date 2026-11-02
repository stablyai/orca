import type { GitAdmissionTier } from '../../shared/rpc-contract/git-admission-tier-params'
import { gitExecFileAsync } from './runner'
import { resolveDefaultBaseRefViaExec } from '../../shared/git-default-base-ref'

export {
  DEFAULT_BASE_REF_PROBES,
  resolveDefaultBaseRefViaExec
} from '../../shared/git-default-base-ref'
export type { GitExec } from '../../shared/git-default-base-ref'

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export type LocalDefaultBaseRefGitOptions = {
  cwd: string
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export const DEFAULT_BASE_REF_PROBE_TIMEOUT_MS = 15_000

export function gitExecOptions(
  cwd: string,
  options: LocalGitExecOptions = {}
): LocalDefaultBaseRefGitOptions {
  return {
    cwd,
    ...(options.wslDistro ? { wslDistro: options.wslDistro } : {}),
    ...(options.admissionTier ? { admissionTier: options.admissionTier } : {})
  }
}

export async function getBaseRefDefault(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return getDefaultBaseRefAsync(path, options)
}

export function resolveDefaultBaseRefWithLocalGit(
  options: LocalDefaultBaseRefGitOptions
): Promise<string | null> {
  return resolveDefaultBaseRefViaExec((argv) =>
    gitExecFileAsync(argv, {
      ...options,
      timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS
    })
  )
}

export function getDefaultBaseRefAsync(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefWithLocalGit(gitExecOptions(path, options))
}
