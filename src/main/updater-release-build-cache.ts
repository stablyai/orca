import type { ReleaseBuild, ReleaseChannel } from '../shared/release-channel'

const DEFAULT_TTL_MS = 5 * 60_000

type LoadBuilds = (channel: ReleaseChannel) => Promise<ReleaseBuild[]>

type CacheEntry = { builds: Promise<ReleaseBuild[]>; expiresAt: number }

export type ReleaseBuildListOptions = {
  /** Bypass the cache — the refresh button, so a build published a minute ago shows up on demand. */
  force?: boolean
}

/**
 * Per-channel cache of listed release builds.
 *
 * Why: the picker reloads on every settings mount and every channel click, and
 * each load was one GitHub API request. Serving repeats from here keeps a few
 * minutes of browsing at one request per channel, and sharing the in-flight
 * promise collapses two concurrent loads of one channel into a single request.
 */
export class ReleaseBuildListCache {
  private readonly entries = new Map<ReleaseChannel, CacheEntry>()

  constructor(
    private readonly load: LoadBuilds,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  list(channel: ReleaseChannel, options: ReleaseBuildListOptions = {}): Promise<ReleaseBuild[]> {
    const existing = this.entries.get(channel)
    if (!options.force && existing && existing.expiresAt > this.now()) {
      return existing.builds
    }
    const builds = this.load(channel)
    const entry: CacheEntry = { builds, expiresAt: this.now() + this.ttlMs }
    this.entries.set(channel, entry)
    // Why: a failed load must not be served for the next five minutes; drop it so
    // the next call retries. Only evict our own entry — a forced reload may have replaced it.
    builds.catch(() => {
      if (this.entries.get(channel) === entry) {
        this.entries.delete(channel)
      }
    })
    return builds
  }
}
