import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  REPO_PATH_STATUS_TTL_MS,
  type RepoPathStatus,
  type RepoPathStatusEntry
} from '../../shared/repo-path-status'
import type { Repo } from '../../shared/repo-types'
import { resolveRepoHostFilesystem, type RepoHostFilesystem } from './repo-host-filesystem'

const REPO_PATH_STATUS_CONCURRENCY = 8

async function inspectCheckoutRoot(
  fs: RepoHostFilesystem,
  root: string
): Promise<'checkout' | 'no-marker' | 'unverifiable'> {
  // Why a marker stat and not `git rev-parse`: this runs for every repo on focus, and a
  // `.git` entry is what every top-level has; the relink itself runs the real git check.
  const marker = await fs.inspectEntry(fs.join(root, '.git'))
  if (marker === 'unverifiable') {
    return 'unverifiable'
  }
  return marker === 'absent' ? 'no-marker' : 'checkout'
}

async function inspectSymlinkedRoot(fs: RepoHostFilesystem, path: string): Promise<RepoPathStatus> {
  const target = await fs.resolveRealPath(path)
  if (!target) {
    const followed = await fs.inspectTarget(path)
    return followed === 'absent'
      ? { state: 'missing', reason: 'not-found' }
      : { state: 'unverifiable' }
  }
  const targetKind = await fs.inspectTarget(target)
  if (targetKind === 'unverifiable') {
    return { state: 'unverifiable' }
  }
  if (targetKind !== 'directory') {
    return { state: 'missing', reason: targetKind === 'absent' ? 'not-found' : 'not-directory' }
  }
  const checkout = await inspectCheckoutRoot(fs, target)
  if (checkout === 'unverifiable') {
    return { state: 'unverifiable' }
  }
  return checkout === 'checkout'
    ? { state: 'moved', target }
    : { state: 'missing', reason: 'not-git-root' }
}

/** Classifies a git repo's registered folder on the host that owns it. */
export async function inspectRepoPathStatus(
  path: string,
  fs: RepoHostFilesystem | null
): Promise<RepoPathStatus> {
  if (!fs) {
    return { state: 'unverifiable' }
  }
  const entry = await fs.inspectEntry(path)
  switch (entry) {
    case 'unverifiable':
      return { state: 'unverifiable' }
    case 'absent':
      return { state: 'missing', reason: 'not-found' }
    case 'file':
      return { state: 'missing', reason: 'not-directory' }
    case 'symlink':
      return inspectSymlinkedRoot(fs, path)
    case 'directory': {
      const checkout = await inspectCheckoutRoot(fs, path)
      if (checkout === 'unverifiable') {
        return { state: 'unverifiable' }
      }
      return checkout === 'checkout'
        ? { state: 'present' }
        : { state: 'missing', reason: 'not-git-root' }
    }
  }
}

type CachedRepoPathStatus = { entry: RepoPathStatusEntry; checkedAt: number }

export class RepoPathStatusCollector {
  private readonly cache = new Map<string, CachedRepoPathStatus>()

  constructor(
    private readonly resolveFilesystem: typeof resolveRepoHostFilesystem = resolveRepoHostFilesystem,
    private readonly now: () => number = Date.now
  ) {}

  /** Repos on runtime hosts are skipped: their own server answers for them. */
  async collect(
    repos: readonly Repo[],
    options: { force?: boolean } = {}
  ): Promise<RepoPathStatusEntry[]> {
    const candidates = repos.filter(
      (repo) =>
        !isFolderRepo(repo) &&
        parseExecutionHostId(getRepoExecutionHostId(repo))?.kind !== 'runtime'
    )
    const results = await mapWithConcurrency(candidates, REPO_PATH_STATUS_CONCURRENCY, (repo) =>
      this.inspect(repo, options.force === true)
    )
    const liveKeys = new Set(candidates.map((repo) => this.cacheKey(repo)))
    for (const key of this.cache.keys()) {
      if (!liveKeys.has(key)) {
        this.cache.delete(key)
      }
    }
    return results
  }

  invalidate(repoId: string): void {
    for (const [key, cached] of this.cache) {
      if (cached.entry.repoId === repoId) {
        this.cache.delete(key)
      }
    }
  }

  private cacheKey(repo: Repo): string {
    return `${getRepoExecutionHostId(repo)}\0${repo.id}\0${repo.path}`
  }

  private async inspect(repo: Repo, force: boolean): Promise<RepoPathStatusEntry> {
    const key = this.cacheKey(repo)
    const cached = this.cache.get(key)
    if (!force && cached && this.now() - cached.checkedAt < REPO_PATH_STATUS_TTL_MS) {
      return cached.entry
    }
    const hostId = getRepoExecutionHostId(repo)
    const status = await inspectRepoPathStatus(repo.path, this.resolveFilesystem(hostId))
    const entry: RepoPathStatusEntry = { repoId: repo.id, hostId, path: repo.path, status }
    // Why not cache unverifiable: a reconnect should be able to answer on the next focus.
    if (status.state !== 'unverifiable') {
      this.cache.set(key, { entry, checkedAt: this.now() })
    } else {
      this.cache.delete(key)
    }
    return entry
  }
}
