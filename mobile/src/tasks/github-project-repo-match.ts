import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../../src/shared/github-repository-identity-key'

export type GitHubProjectRepoMatch = {
  id: string
  path: string
  displayName: string
}

export type GitHubRepoSlugCacheEntry = {
  path: string
  repository: { owner: string; repo: string; host?: string } | null
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
