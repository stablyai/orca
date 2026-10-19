import type { GitHubOwnerRepo } from '../../../../shared/github/pull-request-types'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../../shared/github/repository-identity-key'
import { isValidGitHubApiRepository } from '../../github-api-repository-validation'
import type { OwnerRepo } from '../../gh-utils'

function hostKey(host: string | undefined): string {
  return isDefaultGitHubHost(host) ? '' : (host ?? '').trim().toLowerCase()
}

/**
 * The repository of a URL-linked PR when it is none of the row's own GitHub
 * remotes (e.g. a submodule's repo). Null keeps the remote-candidate lookup, so
 * links into origin/upstream behave exactly as bare numbers.
 */
export function linkedPRRepositoryOutsideRemotes(
  linked: GitHubOwnerRepo | null | undefined,
  candidates: readonly OwnerRepo[]
): OwnerRepo | null {
  if (!isValidGitHubApiRepository(linked)) {
    return null
  }
  const key = githubRepoIdentityKey(linked)
  if (candidates.some((candidate) => githubRepoIdentityKey(candidate) === key)) {
    return null
  }
  // Why: a stored URL may only point gh at a GitHub server this row already uses.
  const sameHost = candidates.find((candidate) => hostKey(candidate.host) === hostKey(linked.host))
  if (!sameHost) {
    return null
  }
  return {
    owner: linked.owner,
    repo: linked.repo,
    ...(sameHost.host ? { host: sameHost.host } : {})
  }
}
