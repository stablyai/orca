import type { ReleaseBuild, ReleaseChannel } from '../shared/release-channel'

const DEFAULT_TTL_MS = 5 * 60_000

type LoadBuilds = (channel: ReleaseChannel) => Promise<ReleaseBuild[]>

type CacheEntry = { builds: Promise<ReleaseBuild[]>; expiresAt: number }

export type ReleaseBuildListOptions = {
  force?: boolean
}

// Repeated picker mounts/channel switches share API results and in-flight requests.
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
    // Retry failed loads, but do not evict a newer forced reload.
    builds.catch(() => {
      if (this.entries.get(channel) === entry) {
        this.entries.delete(channel)
      }
    })
    return builds
  }
}
