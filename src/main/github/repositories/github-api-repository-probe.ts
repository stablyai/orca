import { githubRepoContext, type LocalGitExecOptions } from './github-repository-identity'

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
  const { ghAccount } = githubRepoContext(repoPath, connectionId, localGitOptions)
  return `${runtimeKey}\0${repoPath}\0${remoteName}\0${requireVerifiedSshProbe ? 'verified' : 'tolerant'}\0${JSON.stringify(ghAccount ?? null)}`
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
