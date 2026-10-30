import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../src/shared/github/repository-identity-key'

export type GitHubProjectRepoMatch = {
  id: string
  path: string
  displayName: string
  // Absent fork parent means non-fork or not yet resolved.
  upstream?: { owner: string; repo: string; host?: string } | null
}

export type GitHubRepoSlugCacheEntry = {
  path: string
  repository: { owner: string; repo: string; host?: string } | null
  failed?: boolean
}

// Drop cached slug failures on refresh so transient errors cannot hide Project rows forever.
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

// Legacy fork metadata may omit upstream.host; inherit resolved origin host to avoid mapping GHES to github.com.
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

  // Match origin before fork parent so upstream clones win, while personal forks still receive upstream Project rows.
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
    // Names and paths give no host evidence; using them could map GHES items onto github.com repos.
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
  const matchedRepositories = new Map<string | null | undefined, boolean>()
  return rows.filter((row) => {
    const repository = row.content.repository
    const cached = matchedRepositories.get(repository)
    if (cached !== undefined) {
      return cached
    }
    const matched = Boolean(
      findRepoForGitHubProjectRepository(repository, repos, slugsByRepoId, projectHost)
    )
    matchedRepositories.set(repository, matched)
    return matched
  })
}
