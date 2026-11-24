import type { GitHubRepositoryIdentity } from '../../../shared/github/repositories/repository-identity'
import { githubRepoIdentityKey } from '../../../shared/github/repositories/repository-identity-key'
import {
  resolveGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates
} from './github-api-repository'
import type { LocalGitExecOptions } from './github-repository-identity'

function githubHostKey(host?: string): string {
  return host?.trim().toLowerCase() || 'github.com'
}

export async function resolveGitHubWorkItemLinkRepository(
  repoPath: string,
  repository: GitHubRepositoryIdentity,
  { allowSameHost }: { allowSameHost?: boolean },
  connectionId?: string | null,
  localGitOptions?: LocalGitExecOptions
): Promise<GitHubRepositoryIdentity | null> {
  const requestedHost = repository.host?.trim().toLowerCase()
  const requestedRepository = requestedHost
    ? { ...repository, host: requestedHost }
    : await resolveGitHubApiRepository(repoPath, repository, connectionId, localGitOptions)
  if (!requestedRepository) {
    return null
  }

  const { candidates } = await resolveGitHubApiRepositoryCandidates(
    repoPath,
    connectionId,
    localGitOptions
  )
  const requestedKey = githubRepoIdentityKey(requestedRepository)
  const requestedHostKey = githubHostKey(requestedRepository.host)
  // Link previews may read another repository on a host already configured for the workspace.
  return (
    candidates.find((candidate) => githubRepoIdentityKey(candidate) === requestedKey) ??
    (allowSameHost &&
    candidates.some((candidate) => githubHostKey(candidate.host) === requestedHostKey)
      ? requestedRepository
      : null)
  )
}
