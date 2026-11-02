import {
  findKilledPlugin,
  isPluginKillListTooFarInFuture,
  pluginKillListSchema,
  type PluginKillList,
  type PluginKillListEntry
} from '../../../shared/plugins/catalog/plugin-kill-list'
import { PluginKillListStore } from './plugin-kill-list-store'
import { fetchBoundedJson } from './plugin-bounded-json-fetch'

export const PLUGIN_KILL_LIST_URL = 'https://onorca.dev/plugins/kill-list.json'
const PLUGIN_KILL_LIST_DOWNLOAD_LIMIT = 4 * 1024 * 1024
// Why: revocations must reach sessions that stay open for days, not only fresh launches.
export const PLUGIN_KILL_LIST_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
// Why: a failed refresh must not leave revocations hours stale until the next interval.
export const PLUGIN_KILL_LIST_RETRY_MS = 15 * 60 * 1000
const PLUGIN_KILL_LIST_RETRY_CAP_MS = 2 * 60 * 60 * 1000
// Why: refreshes are chained, so one stalled request would block every later one.
const PLUGIN_KILL_LIST_FETCH_TIMEOUT_MS = 30_000

type PluginKillListFetcher = () => Promise<PluginKillList>

export class PluginKillListService {
  private readonly store: PluginKillListStore
  private readonly fetcher: PluginKillListFetcher
  private readonly listeners = new Set<() => void>()
  private currentList: PluginKillList | null = null
  private loadPromise: Promise<void> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private refreshChain: Promise<PluginKillList> = Promise.resolve(emptyKillList())

  constructor(options: {
    pluginsDataDir: string
    store?: PluginKillListStore
    fetcher?: PluginKillListFetcher
  }) {
    this.store = options.store ?? new PluginKillListStore(options.pluginsDataDir)
    this.fetcher = options.fetcher ?? (() => fetchPluginKillList())
  }

  async initialize(): Promise<void> {
    this.loadPromise ??= this.store
      .read()
      .then((killList) => {
        this.currentList = killList
      })
      .catch((error) => {
        // Invalid cache cannot block startup; network refresh can still restore revocations.
        console.warn('[plugins] ignoring invalid cached plugin safety list:', error)
        this.currentList = null
      })
    await this.loadPromise
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  find(pluginKey: string): PluginKillListEntry | null {
    return this.currentList ? findKilledPlugin(this.currentList, pluginKey) : null
  }

  reason(pluginKey: string): string | null {
    return this.find(pluginKey)?.reason ?? null
  }

  snapshot(): PluginKillList | null {
    return this.currentList
  }

  refresh(): Promise<PluginKillList> {
    const refresh = this.refreshChain
      .catch(() => this.currentList ?? emptyKillList())
      .then(() => this.performRefresh())
    this.refreshChain = refresh
    refresh.then(
      () => {
        this.failures = 0
      },
      () => this.scheduleRetry()
    )
    return refresh
  }

  private scheduleRetry(): void {
    if (!this.periodicTimer || this.retryTimer) {
      return
    }
    this.failures += 1
    const delay = Math.min(
      PLUGIN_KILL_LIST_RETRY_MS * 2 ** (this.failures - 1),
      PLUGIN_KILL_LIST_RETRY_CAP_MS
    )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.refreshInBackground()
    }, delay)
    this.retryTimer.unref?.()
  }

  /** Keeps a background refresh running while plugins are on; stops it when they are off. */
  syncPeriodicRefresh(enabled: boolean, intervalMs = PLUGIN_KILL_LIST_REFRESH_INTERVAL_MS): void {
    if (!enabled) {
      this.dispose()
      return
    }
    if (this.periodicTimer) {
      return
    }
    this.periodicTimer = setInterval(() => this.refreshInBackground(), intervalMs)
    this.periodicTimer.unref?.()
  }

  private refreshInBackground(): void {
    void this.refresh().catch((error) =>
      console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
    )
  }

  dispose(): void {
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }

  private async performRefresh(): Promise<PluginKillList> {
    await this.initialize()
    const fetched = pluginKillListSchema.parse(await this.fetcher())
    if (isPluginKillListTooFarInFuture(fetched)) {
      throw new Error('refusing a plugin kill list generated too far in the future')
    }
    if (
      this.currentList &&
      Date.parse(fetched.generatedAt) < Date.parse(this.currentList.generatedAt)
    ) {
      throw new Error('refusing to replace the plugin kill list with an older snapshot')
    }
    await this.store.write(fetched)
    this.currentList = fetched
    for (const listener of this.listeners) {
      listener()
    }
    return fetched
  }
}

export async function fetchPluginKillList(
  fetcher: typeof fetch = fetch,
  url = PLUGIN_KILL_LIST_URL
): Promise<PluginKillList> {
  const json = await fetchBoundedJson(fetcher, url, {
    label: 'plugin kill-list',
    maxBytes: PLUGIN_KILL_LIST_DOWNLOAD_LIMIT,
    timeoutMs: PLUGIN_KILL_LIST_FETCH_TIMEOUT_MS
  })
  try {
    const parsed = pluginKillListSchema.parse(json)
    if (isPluginKillListTooFarInFuture(parsed)) {
      throw new Error('generatedAt is too far in the future')
    }
    return parsed
  } catch (error) {
    throw new Error(
      `invalid plugin kill-list response: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function emptyKillList(): PluginKillList {
  return { version: 1, generatedAt: '1970-01-01T00:00:00Z', plugins: [] }
}
