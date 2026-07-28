import {
  findKilledPlugin,
  pluginKillListSchema,
  type PluginKillList,
  type PluginKillListEntry
} from '../../shared/plugins/plugin-kill-list'
import { PluginKillListStore } from './plugin-kill-list-store'

export const PLUGIN_KILL_LIST_URL = 'https://onorca.dev/plugins/kill-list.json'
const PLUGIN_KILL_LIST_DOWNLOAD_LIMIT = 4 * 1024 * 1024

type PluginKillListFetcher = () => Promise<PluginKillList>

export class PluginKillListService {
  private readonly store: PluginKillListStore
  private readonly fetcher: PluginKillListFetcher
  private readonly listeners = new Set<() => void>()
  private currentList: PluginKillList | null = null
  private loadPromise: Promise<void> | null = null
  private refreshChain: Promise<PluginKillList> = Promise.resolve({
    version: 1,
    generatedAt: '1970-01-01T00:00:00Z',
    plugins: []
  })

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
        // Why: an unusable cache must not prevent Orca from starting; a valid
        // network refresh can still restore runtime revocations this session.
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
    return refresh
  }

  private async performRefresh(): Promise<PluginKillList> {
    await this.initialize()
    const fetched = pluginKillListSchema.parse(await this.fetcher())
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
  const response = await fetcher(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`plugin kill-list request failed with HTTP ${response.status}`)
  }
  const declaredBytes = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredBytes) && declaredBytes > PLUGIN_KILL_LIST_DOWNLOAD_LIMIT) {
    throw new Error('plugin kill-list response exceeds its size limit')
  }
  if (!response.body) {
    throw new Error('plugin kill-list response has no body')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    totalBytes += chunk.value.byteLength
    if (totalBytes > PLUGIN_KILL_LIST_DOWNLOAD_LIMIT) {
      await reader.cancel()
      throw new Error('plugin kill-list response exceeds its size limit')
    }
    chunks.push(chunk.value)
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return pluginKillListSchema.parse(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (error) {
    throw new Error(
      `invalid plugin kill-list response: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function emptyKillList(): PluginKillList {
  return { version: 1, generatedAt: '1970-01-01T00:00:00Z', plugins: [] }
}
