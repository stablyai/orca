import { isValidGitHubApiRepository } from './github-api-repository-validation'
import { isDefaultGitHubHost } from '../../shared/github/repository-identity-key'
import type { GitHubApiRepository } from './github-api-repository'
import type { LocalGitExecOptions } from './gh-utils'

export async function selectGitHubApiRepository(args: {
  repoPath: string
  repository?: GitHubApiRepository | null
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
  isHostAuthenticated: (host: string) => Promise<boolean>
  resolveOrigin: () => Promise<GitHubApiRepository | null>
}): Promise<GitHubApiRepository | null> {
  if (args.repository && !isValidGitHubApiRepository(args.repository)) {
    return null
  }
  if (args.repository?.host) {
    const host = args.repository.host.trim().toLowerCase()
    if (!host) {
      return null
    }
    if (isDefaultGitHubHost(host)) {
      return { ...args.repository, host }
    }
    return (await args.isHostAuthenticated(host)) ? { ...args.repository, host } : null
  }
  const originRepository = await args.resolveOrigin()
  if (!args.repository) {
    return originRepository
  }
  // Why: older clients only send owner/repo. Origin supplies the execution host
  // for fork-base slugs on the same GitHub Enterprise server.
  return originRepository?.host ? { ...args.repository, host: originRepository.host } : null
}
