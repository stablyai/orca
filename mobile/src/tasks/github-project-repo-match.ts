import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../src/shared/github-repository-identity-key'

export type GitHubProjectRepoMatch = {
  id: string
  path: string
  displayName: string
  /** Fork parent resolved by the host and carried on `repo.list`. Absent = not
   *  a fork or not yet resolved. */
  upstream?: { owner: string; repo: string; host?: string } | null
}

export type GitHubRepoSlugCacheEntry = {
  path: string
  repository: { owner: string; repo: string; host?: string } | null
  /** Resolution failed rather than resolving to "no repository". Cached so the
   *  board stops waiting on it, but dropped on refresh so it is retried. */
  failed?: boolean
}

/** Why: a transient `github.repoSlug` error would otherwise be cached forever as
 *  an unresolved repo, filtering its rows out of every future board render. */
export function dropFailedGitHubRepoSlugEntries(
  slugsByRepoId: Record<string, GitHubRepoSlugCacheEntry | undefined>
): Record<string, GitHubRepoSlugCacheEntry | undefined> {
  const retryable = Object.entries(slugsByRepoId).filter(([, entry]) => entry?.failed === true)
  if (retryable.length === 0) {
    return slugsByRepoId
  }
  const next = { ...slugsByRepoId }
  for (const [repoId] of retryable) {
    delete next[repoId]
  }
  return next
}

type CachedSlugState =
  | { status: 'missing' }
  | { status: 'stale' }
  | { status: 'resolved'; repository: GitHubRepoSlugCacheEntry['repository'] }

export function normalizeGitHubRepositorySlug(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }
  const [owner, repo, extra] = trimmed.split('/')
  if (!owner || !repo || extra) {
    return null
  }
  return `${owner}/${repo}`.toLowerCase()
}

function cachedSlugStateForRepo(
  repo: GitHubProjectRepoMatch,
  slugsByRepoId: Record<string, GitHubRepoSlugCacheEntry | undefined>
): CachedSlugState {
  const cached = slugsByRepoId[repo.id]
  if (!cached) {
    return { status: 'missing' }
  }
  if (cached.path !== repo.path) {
    return { status: 'stale' }
  }
  return { status: 'resolved', repository: cached.repository }
}

/** Identity key of the repo's fork parent, or null when it is not a fork or its
 *  origin has not resolved. Why: when `upstream.host` is absent (older persisted
 *  forks), the fork's origin host is the fallback so GHES parents do not collapse
 *  into github.com. Unresolved origins refuse the alias. */
function upstreamIdentityKeyForRepo(
  repo: GitHubProjectRepoMatch,
  originState: CachedSlugState | undefined
): string | null {
  const upstream = repo.upstream
  if (!upstream?.owner || !upstream.repo) {
    return null
  }
  if (originState?.status !== 'resolved' || !originState.repository) {
    return null
  }
  return githubRepoIdentityKey({
    ...upstream,
    host: upstream.host ?? originState.repository.host
  })
}

export function findRepoForGitHubProjectRepository(
  repository: string | null | undefined,
  repos: GitHubProjectRepoMatch[],
  slugsByRepoId: Record<string, GitHubRepoSlugCacheEntry | undefined> = {},
  projectHost?: string
): GitHubProjectRepoMatch | null {
  const slug = normalizeGitHubRepositorySlug(repository)
  if (!slug) {
    return null
  }

  const slugStates = new Map(
    repos.map((repo) => [repo.id, cachedSlugStateForRepo(repo, slugsByRepoId)])
  )
  const requestedIdentityKey = githubRepoIdentityKey({
    owner: slug.split('/')[0]!,
    repo: slug.split('/')[1]!,
    ...(projectHost ? { host: projectHost } : {})
  })
  const slugMatches = repos.filter((repo) => {
    const state = slugStates.get(repo.id)
    return (
      state?.status === 'resolved' &&
      state.repository !== null &&
      githubRepoIdentityKey(state.repository) === requestedIdentityKey
    )
  })
  if (slugMatches.length === 1) {
    return slugMatches[0]!
  }
  if (slugMatches.length > 1) {
    return null
  }

  // Why: a Project card references the upstream repo, but a contributor's clone
  // has their personal fork as `origin`, so origin-only matching hid every row
  // (#12647). Checked after origin so an open clone of the upstream repo itself
  // always wins over someone's fork of it.
  const upstreamMatches = repos.filter(
    (repo) => upstreamIdentityKeyForRepo(repo, slugStates.get(repo.id)) === requestedIdentityKey
  )
  if (upstreamMatches.length === 1) {
    return upstreamMatches[0]!
  }
  if (upstreamMatches.length > 1) {
    return null
  }

  if (!isDefaultGitHubHost(projectHost)) {
    // Why: display names and local paths contain no host evidence, so using
    // them for GHES rows could bind an Enterprise item to a github.com repo.
    return null
  }

  return (
    repos.find((repo) => {
      const state = slugStates.get(repo.id)
      if (state?.status === 'resolved' && state.repository !== null) {
        return false
      }
      const display = repo.displayName.trim().toLowerCase()
      const path = repo.path.trim().toLowerCase().replace(/\\/g, '/')
      return display === slug || path.endsWith(`/${slug}`)
    }) ?? null
  )
}

export function filterGitHubProjectRowsForRepos<
  Row extends { content: { repository?: string | null } }
>(
  rows: readonly Row[],
  repos: GitHubProjectRepoMatch[],
  slugsByRepoId: Record<string, GitHubRepoSlugCacheEntry | undefined> = {},
  projectHost?: string
): Row[] {
  return rows.filter((row) =>
    Boolean(
      findRepoForGitHubProjectRepository(row.content.repository, repos, slugsByRepoId, projectHost)
    )
  )
}
