import { isGitHubOwnerSlug } from '../../../shared/github/repositories/owner-slug'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../shared/github/repositories/repository-identity'
import { isGitHubRepositorySlug } from '../../../shared/github/repositories/repository-slug'

export type GitHubApiRepositoryResolution =
  | GitHubOwnerRepo
  | null
  | undefined
  | (() => Promise<GitHubOwnerRepo | null>)

// Untrusted renderer/RPC slugs become authenticated REST paths.
export function isValidGitHubApiRepository(repository: unknown): repository is GitHubOwnerRepo {
  if (
    !repository ||
    typeof repository !== 'object' ||
    !('owner' in repository) ||
    !('repo' in repository)
  ) {
    return false
  }
  return (
    isGitHubOwnerSlug(repository.owner) &&
    isGitHubRepositorySlug(repository.repo) &&
    (!('host' in repository) ||
      repository.host === undefined ||
      typeof repository.host === 'string')
  )
}
