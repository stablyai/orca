import { getRepoExecutionHostId } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import { resolveLocalGitUsernameDetailed } from './git/git-username'
import { blockedWslDistroForPath, wslDistroForPath } from './wsl/wsl-unc-access-gate'

type RepoUsernameStore = {
  getRepos(): Repo[]
  // Repo ids can repeat across hosts.
  setResolvedRepoGitUsername(
    target: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>,
    username: string
  ): boolean
}

type EnrichmentOptions = {
  onChanged?: () => void
}

// Probe once per location per session; serve the persisted value between launches.
const attemptedLocations = new Set<string>()
let enrichmentInFlight: Promise<void> | null = null
let rerunRequested = false

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId' | 'executionHostId'>): string {
  return `${getRepoExecutionHostId(repo)}\0${repo.path}`
}

async function enrichRepoGitUsernamesInBackground(
  store: RepoUsernameStore,
  options: EnrichmentOptions
): Promise<void> {
  const repos = store.getRepos()
  const liveLocations = new Set(
    repos.filter((repo) => repo.kind !== 'folder' && !repo.connectionId).map(getRepoLocationKey)
  )
  for (const location of attemptedLocations) {
    if (!liveLocations.has(location)) {
      attemptedLocations.delete(location)
    }
  }
  const candidates = repos.filter(
    (repo) =>
      repo.kind !== 'folder' &&
      !repo.connectionId &&
      !attemptedLocations.has(getRepoLocationKey(repo))
  )
  let changed = false
  for (const repo of candidates) {
    // E9: git on a stopped distro's repo boots it; leave it unattempted so a later pass retries.
    if (wslDistroForPath(repo.path) && (await blockedWslDistroForPath(repo.path))) {
      continue
    }
    attemptedLocations.add(getRepoLocationKey(repo))
    const { username, authoritative } = await resolveLocalGitUsernameDetailed(repo.path)
    // Preserve cached usernames on failure; authoritative empty results clear stale accounts.
    if (!authoritative && !username) {
      continue
    }
    if (store.setResolvedRepoGitUsername(repo, username)) {
      changed = true
    }
  }
  if (changed) {
    options.onChanged?.()
  }
}

// Keep repo-list calls subprocess-free to avoid blocking startup.
export function enrichRepoGitUsernames(
  store: RepoUsernameStore,
  options: EnrichmentOptions = {}
): void {
  if (enrichmentInFlight) {
    // Pick up repos added while the current pass was probing.
    rerunRequested = true
    return
  }
  enrichmentInFlight = enrichRepoGitUsernamesInBackground(store, options)
    .catch((error: unknown) => {
      console.error('[repo-username] Failed to enrich git usernames:', error)
    })
    .finally(() => {
      enrichmentInFlight = null
      if (rerunRequested) {
        rerunRequested = false
        enrichRepoGitUsernames(store, options)
      }
    })
}

export async function flushRepoGitUsernameEnrichmentForTests(): Promise<void> {
  // A queued rerun replaces enrichmentInFlight when the first pass settles.
  while (enrichmentInFlight) {
    await enrichmentInFlight
  }
}

export function resetRepoGitUsernameEnrichmentForTests(): void {
  attemptedLocations.clear()
  enrichmentInFlight = null
  rerunRequested = false
}
