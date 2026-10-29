import type { LocalGitExecOptions } from './github-repository-identity'
import { githubReadExecutionScope } from './github-read-execution-scope'

export function githubApiRepositoryProbeCacheKey(
  repoPath: string,
  remoteName: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  requireVerifiedSshProbe: boolean
): string {
  const runtimeKey = connectionId
    ? `ssh:${connectionId}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  return `${runtimeKey}\0${repoPath}\0${remoteName}\0${requireVerifiedSshProbe ? 'verified' : 'tolerant'}\0${githubReadExecutionScope(localGitOptions)}`
}

export function resolveGitHubApiRepositoryProbe<T>(
  value: T | undefined,
  requireVerifiedSshProbe: boolean
): T | null {
  if (value === undefined && requireVerifiedSshProbe) {
    throw new Error('GitHub repository identity is unverifiable.')
  }
  return value ?? null
}
