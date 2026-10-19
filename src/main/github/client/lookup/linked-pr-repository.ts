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
 * Where an exact linked-PR lookup may look. Null: the row's remotes (no URL
 * repository, or it names one of them, so it behaves exactly as a bare number).
 * A repository: the URL's own repository, e.g. a submodule's. 'refused': the URL
 * names a repository this row may not query, so report no PR rather than the
 * row's own, unrelated PR with the same number.
 */
export function linkedPRLookupRepository(
  linkedPRNumber: number | null | undefined,
  options: { linkedPRRepository?: GitHubOwnerRepo | null },
  candidates: readonly OwnerRepo[]
): OwnerRepo | null | 'refused' {
  const linked = options.linkedPRRepository
  if (typeof linkedPRNumber !== 'number' || !linked) {
    return null
  }
  if (!isValidGitHubApiRepository(linked)) {
    return 'refused'
  }
  const key = githubRepoIdentityKey(linked)
  if (candidates.some((candidate) => githubRepoIdentityKey(candidate) === key)) {
    return null
  }
  // Why: a stored URL may only point gh at a GitHub server this row already uses.
  const sameHost = candidates.find((candidate) => hostKey(candidate.host) === hostKey(linked.host))
  if (!sameHost) {
    return 'refused'
  }
  return {
    owner: linked.owner,
    repo: linked.repo,
    ...(sameHost.host ? { host: sameHost.host } : {})
  }
}
