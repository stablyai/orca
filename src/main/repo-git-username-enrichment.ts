import type { Repo } from '../shared/types'
import { resolveLocalGitUsername } from './git/git-username'

type RepoUsernameStore = {
  getRepos(): Repo[]
  setResolvedRepoGitUsername(id: string, username: string): boolean
}

type EnrichmentOptions = {
  onChanged?: () => void
}

// Why: resolution spawns git (and possibly gh) subprocesses, so run it at most
// once per repo location per app session — hydrateRepo serves the persisted
// value in between, and a relaunch picks up config changes.
const attemptedLocations = new Set<string>()
let enrichmentInFlight: Promise<void> | null = null

function getRepoLocationKey(repo: Pick<Repo, 'path' | 'connectionId'>): string {
  return `${repo.connectionId ?? 'local'}\0${repo.path}`
}

async function enrichRepoGitUsernamesInBackground(
  store: RepoUsernameStore,
  options: EnrichmentOptions
): Promise<void> {
  const candidates = store.getRepos().filter(
    (repo) =>
      repo.kind !== 'folder' &&
      // Why: SSH repo paths are remote; local git cannot inspect them. The
      // SSH username path (getSshGitUsername) stays caller-driven.
      !repo.connectionId &&
      !attemptedLocations.has(getRepoLocationKey(repo))
  )
  let changed = false
  for (const repo of candidates) {
    attemptedLocations.add(getRepoLocationKey(repo))
    const username = await resolveLocalGitUsername(repo.path)
    // Why: '' can mean a transient probe failure (offline gh, stuck git), so
    // never clear a previously persisted username with it.
    if (username && store.setResolvedRepoGitUsername(repo.id, username)) {
      changed = true
    }
  }
  if (changed) {
    options.onChanged?.()
  }
}

/**
 * Resolve git usernames for repos that haven't been probed this session, off
 * the caller's critical path. Fire-and-forget by design: repos:list must stay
 * subprocess-free (issue #7225 — a stuck sync probe froze startup for minutes).
 */
export function enrichRepoGitUsernames(
  store: RepoUsernameStore,
  options: EnrichmentOptions = {}
): void {
  if (enrichmentInFlight) {
    return
  }
  enrichmentInFlight = enrichRepoGitUsernamesInBackground(store, options)
    .catch((error: unknown) => {
      console.error('[repo-username] Failed to enrich git usernames:', error)
    })
    .finally(() => {
      enrichmentInFlight = null
    })
}

export async function flushRepoGitUsernameEnrichmentForTests(): Promise<void> {
  await enrichmentInFlight
}

export function resetRepoGitUsernameEnrichmentForTests(): void {
  attemptedLocations.clear()
  enrichmentInFlight = null
}
