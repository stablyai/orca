import { GITHUB_OWNER_SLUG_RE } from '../../../shared/github/repositories/owner-slug'
import type { GitHubRepositoryIdentity as GitHubOwnerRepo } from '../../../shared/github/repositories/repository-identity'

export type GitHubApiRepositoryResolution =
  | GitHubOwnerRepo
  | null
  | undefined
  | (() => Promise<GitHubOwnerRepo | null>)

// Untrusted renderer/RPC slugs become authenticated REST paths.
const OWNER_SLUG_RE = GITHUB_OWNER_SLUG_RE
const REPOSITORY_SLUG_RE = /^[A-Za-z0-9._-]+$/

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
    typeof repository.owner === 'string' &&
    typeof repository.repo === 'string' &&
    (!('host' in repository) ||
      repository.host === undefined ||
      typeof repository.host === 'string') &&
    OWNER_SLUG_RE.test(repository.owner) &&
    REPOSITORY_SLUG_RE.test(repository.repo) &&
    repository.repo !== '.' &&
    repository.repo !== '..'
  )
}
