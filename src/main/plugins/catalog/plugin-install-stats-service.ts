import { readFile, stat, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  parsePluginInstallStats,
  type PluginInstallStats
} from '../../../shared/plugins/catalog/plugin-install-stats'
import { writePluginFileAtomically } from '../installation/plugin-atomic-file-write'
import { fetchBoundedJson } from './plugin-bounded-json-fetch'

export const PLUGIN_INSTALL_STATS_URL = 'https://onorca.dev/plugins/stats.json'
const PLUGIN_INSTALL_STATS_MAX_BYTES = 2 * 1024 * 1024
const PLUGIN_INSTALL_STATS_FETCH_TIMEOUT_MS = 30_000
// Why 6h: the file is rebuilt daily; counts are display-only, so staleness costs nothing.
export const PLUGIN_INSTALL_STATS_REFRESH_MS = 6 * 60 * 60 * 1000
export const PLUGIN_INSTALL_STATS_RETRY_MS = 15 * 60 * 1000

type PluginInstallStatsFetcher = () => Promise<PluginInstallStats>

/**
 * Public install counts for catalog plugins. Reads return the cached counts at once and start a
 * refresh when stale; any failure only leaves counts hidden or old. Never feeds install decisions.
 */
export class PluginInstallStatsService {
  private readonly filePath: string
  private readonly fetcher: PluginInstallStatsFetcher
  private readonly isFetchAllowed: () => boolean
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private current: PluginInstallStats | null = null
  private loadPromise: Promise<void> | null = null
  private inFlight: Promise<void> | null = null
  private nextFetchAt = 0

  constructor(options: {
    pluginsDataDir: string
    isFetchAllowed: () => boolean
    fetcher?: PluginInstallStatsFetcher
    now?: () => number
  }) {
    this.filePath = join(options.pluginsDataDir, 'plugin-install-stats.json')
    this.isFetchAllowed = options.isFetchAllowed
    this.fetcher = options.fetcher ?? (() => fetchPluginInstallStats())
    this.now = options.now ?? Date.now
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Cached counts by plugin key; starts a background refresh when they are stale. */
  async getInstallCounts(): Promise<Record<string, number>> {
    await this.load()
    this.refreshIfStale()
    return this.current?.installs ?? {}
  }

  /** Settles when a running refresh does; for tests and callers that want fresh counts. */
  async settled(): Promise<void> {
    await this.inFlight
  }

  private load(): Promise<void> {
    this.loadPromise ??= this.readCache().then(
      (cached) => {
        if (cached) {
          this.current = cached.stats
          // Why the file time: a restart must not refetch counts it fetched moments ago.
          this.nextFetchAt = Math.min(
            cached.fetchedAt + PLUGIN_INSTALL_STATS_REFRESH_MS,
            this.now() + PLUGIN_INSTALL_STATS_REFRESH_MS
          )
        }
      },
      (error: unknown) => {
        console.warn('[plugins] ignoring invalid cached plugin install counts:', error)
      }
    )
    return this.loadPromise
  }

  private refreshIfStale(): void {
    if (this.inFlight || this.now() < this.nextFetchAt || !this.isFetchAllowed()) {
      return
    }
    this.inFlight = this.performRefresh()
      .then(
        () => {
          this.nextFetchAt = this.now() + PLUGIN_INSTALL_STATS_REFRESH_MS
        },
        (error: unknown) => {
          this.nextFetchAt = this.now() + PLUGIN_INSTALL_STATS_RETRY_MS
          console.warn('[plugins] failed to refresh plugin install counts:', error)
        }
      )
      .finally(() => {
        this.inFlight = null
      })
  }

  private async performRefresh(): Promise<void> {
    const fetched = await this.fetcher()
    if (this.current && isOlderSnapshot(fetched, this.current)) {
      return
    }
    this.current = fetched
    for (const listener of this.listeners) {
      listener()
    }
    await this.writeCache(fetched).catch((error: unknown) =>
      console.warn('[plugins] failed to cache plugin install counts:', error)
    )
  }

  private async readCache(): Promise<{ stats: PluginInstallStats; fetchedAt: number } | null> {
    try {
      const info = await stat(this.filePath)
      if (info.size > PLUGIN_INSTALL_STATS_MAX_BYTES) {
        throw new Error('cached plugin install counts exceed their size limit')
      }
      const stats = parsePluginInstallStats(JSON.parse(await readFile(this.filePath, 'utf8')))
      return { stats, fetchedAt: info.mtimeMs }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return null
      }
      throw error
    }
  }

  private async writeCache(stats: PluginInstallStats): Promise<void> {
    const plugins = Object.fromEntries(
      Object.entries(stats.installs).map(([pluginKey, installs]) => [pluginKey, { installs }])
    )
    await mkdir(dirname(this.filePath), { recursive: true })
    await writePluginFileAtomically(
      this.filePath,
      `${JSON.stringify({ schemaVersion: 1, generatedAt: stats.generatedAt, plugins })}\n`
    )
  }
}

// Why: a file with no build date (the site's empty placeholder) must not wipe known counts.
function isOlderSnapshot(fetched: PluginInstallStats, current: PluginInstallStats): boolean {
  if (fetched.generatedAt === null) {
    return current.generatedAt !== null
  }
  return (
    current.generatedAt !== null &&
    Date.parse(fetched.generatedAt) < Date.parse(current.generatedAt)
  )
}

export async function fetchPluginInstallStats(
  fetcher: typeof fetch = fetch,
  url = PLUGIN_INSTALL_STATS_URL
): Promise<PluginInstallStats> {
  const json = await fetchBoundedJson(fetcher, url, {
    label: 'plugin install-stats',
    maxBytes: PLUGIN_INSTALL_STATS_MAX_BYTES,
    timeoutMs: PLUGIN_INSTALL_STATS_FETCH_TIMEOUT_MS
  })
  return parsePluginInstallStats(json)
}
