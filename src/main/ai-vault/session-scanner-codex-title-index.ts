import { parseWslUncPath } from '../../shared/wsl-paths'
import { AsyncLocalStorage } from 'node:async_hooks'
import { codexConversationStore, discoverCodexStoreHomes } from '../codex/codex-launch-home'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

// Thread names may arrive here after the transcript was written.

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'
// Bound full title maps retained for custom and WSL homes across a long-lived process.
const CODEX_SESSION_INDEX_TITLE_CACHE_MAX = 64

type IndexedTitle = { title: string; updatedAt: bigint | null }

type CodexSessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, IndexedTitle>
}

const codexSessionIndexTitleCache = new Map<string, Promise<CodexSessionIndexTitleCacheEntry>>()
const inFlightTitleReads = new InFlightPromiseDedupe<Map<string, IndexedTitle>>(
  0,
  CODEX_SESSION_INDEX_TITLE_CACHE_MAX
)

export function resetCodexSessionIndexTitleCacheForTests(): void {
  codexSessionIndexTitleCache.clear()
  inFlightTitleReads.clear()
}

export function _getCodexSessionIndexTitleCacheSizeForTest(): number {
  return codexSessionIndexTitleCache.size
}

export function _hasCodexSessionIndexTitleCacheEntryForTest(codexHome: string): boolean {
  return codexSessionIndexTitleCache.has(codexHome)
}

export function _storeCodexSessionIndexTitleCacheEntryForTest(
  codexHome: string,
  signature: string,
  titles: Promise<Map<string, string>>
): void {
  storeCodexSessionIndexTitleCacheEntry(
    codexHome,
    titles.then((resolvedTitles) => ({
      signature,
      titles: new Map([...resolvedTitles].map(([id, title]) => [id, { title, updatedAt: null }]))
    }))
  )
}

export function _readCachedCodexSessionIndexTitlesForTest(
  codexHome: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  return readCachedCodexSessionIndexTitles(codexHome, signature).then((titles) =>
    titles ? new Map([...titles].map(([id, value]) => [id, value.title])) : undefined
  )
}

export async function readCodexSessionIndexTitle(
  sessionFilePath: string,
  codexHome: string | null,
  sessionId: string
): Promise<string | null> {
  const resolvedCodexHome = codexHome ?? codexHomeFromSessionFilePath(sessionFilePath)
  if (!resolvedCodexHome) {
    return null
  }
  if (parseWslUncPath(resolvedCodexHome)) {
    return (await readCodexSessionIndexTitles(resolvedCodexHome)).get(sessionId)?.title ?? null
  }
  const scope = storeTitleReads.getStore() ?? createTitleReadScope()
  const store = scope.stores.get(resolvedCodexHome) ?? codexConversationStore(resolvedCodexHome)
  scope.stores.set(resolvedCodexHome, store)
  let titles = scope.titles.get(store)
  if (!titles) {
    titles = readStoreTitles(resolvedCodexHome, store, scope)
    scope.titles.set(store, titles)
  }
  return (await titles).get(sessionId)?.title ?? null
}

type TitleReadScope = {
  titles: Map<string, Promise<Map<string, IndexedTitle>>>
  stores: Map<string, string>
  aliases?: Map<string, string[]>
}

const storeTitleReads = new AsyncLocalStorage<TitleReadScope>()
function createTitleReadScope(): TitleReadScope {
  return { titles: new Map(), stores: new Map() }
}
export function withCodexSessionIndexHomes<T>(run: () => Promise<T>): Promise<T> {
  return storeTitleReads.getStore() ? run() : storeTitleReads.run(createTitleReadScope(), run)
}

async function readStoreTitles(
  home: string,
  store: string,
  scope: TitleReadScope
): Promise<Map<string, IndexedTitle>> {
  if (!scope.aliases) {
    scope.aliases = new Map()
    for (const candidate of discoverCodexStoreHomes()) {
      const owner = scope.stores.get(candidate) ?? codexConversationStore(candidate)
      scope.stores.set(candidate, owner)
      const aliases = scope.aliases.get(owner) ?? []
      aliases.push(candidate)
      scope.aliases.set(owner, aliases)
    }
  }
  const indexes = await Promise.all(
    [...new Set([home, ...(scope.aliases.get(store) ?? [])])]
      .sort()
      .map(readCodexSessionIndexTitles)
  )
  const titles = new Map<string, IndexedTitle>()
  for (const index of indexes) {
    for (const [id, value] of index) {
      const previous = titles.get(id)
      // Unknown/equal timestamps retain deterministic alias order; known row dates win.
      if (
        !previous ||
        (value.updatedAt !== null &&
          (previous.updatedAt === null || value.updatedAt >= previous.updatedAt)) ||
        (value.updatedAt === null && previous.updatedAt === null)
      ) {
        titles.set(id, value)
      }
    }
  }
  return titles
}

function codexHomeFromSessionFilePath(sessionFilePath: string): string | null {
  let currentDir = dirname(sessionFilePath)
  while (currentDir && dirname(currentDir) !== currentDir) {
    if (basename(currentDir) === 'sessions') {
      return dirname(currentDir)
    }
    currentDir = dirname(currentDir)
  }
  return null
}

async function readCodexSessionIndexTitles(codexHome: string): Promise<Map<string, IndexedTitle>> {
  const indexPath = join(codexHome, CODEX_SESSION_INDEX_FILE)
  let signature: string
  try {
    const indexStat = await wslGatedStat(indexPath, 'scan')
    signature = `${indexStat.size}:${indexStat.mtimeMs}`
  } catch {
    return new Map()
  }

  const cachedTitles = await readCachedCodexSessionIndexTitles(codexHome, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  // A shared WSL stat resumes cache misses together; share the reload before opening the index.
  return inFlightTitleReads.run(stableInFlightKey([codexHome, signature]), () =>
    loadCodexSessionIndexTitles(codexHome, indexPath, signature)
  )
}

async function loadCodexSessionIndexTitles(
  codexHome: string,
  indexPath: string,
  signature: string
): Promise<Map<string, IndexedTitle>> {
  const cachedTitles = await readCachedCodexSessionIndexTitles(codexHome, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const pending = readCodexSessionIndexTitlesFromDisk(indexPath).then(({ titles, refused }) => {
    // Evict refused WSL reads so retries do not require an index signature change.
    if (refused && codexSessionIndexTitleCache.get(codexHome) === pending) {
      codexSessionIndexTitleCache.delete(codexHome)
    }
    return { signature, titles }
  })
  storeCodexSessionIndexTitleCacheEntry(codexHome, pending)
  return (await pending).titles
}

async function readCachedCodexSessionIndexTitles(
  codexHome: string,
  signature: string
): Promise<Map<string, IndexedTitle> | undefined> {
  const cached = codexSessionIndexTitleCache.get(codexHome)
  if (!cached) {
    return undefined
  }
  const entry = await cached
  if (entry.signature !== signature) {
    return undefined
  }
  // Refresh recency only for the still-current promise; resurrecting an evicted one bypasses the cap.
  if (codexSessionIndexTitleCache.get(codexHome) === cached) {
    codexSessionIndexTitleCache.delete(codexHome)
    codexSessionIndexTitleCache.set(codexHome, cached)
  }
  return entry.titles
}

function storeCodexSessionIndexTitleCacheEntry(
  codexHome: string,
  pending: Promise<CodexSessionIndexTitleCacheEntry>
): void {
  codexSessionIndexTitleCache.delete(codexHome)
  codexSessionIndexTitleCache.set(codexHome, pending)
  if (codexSessionIndexTitleCache.size > CODEX_SESSION_INDEX_TITLE_CACHE_MAX) {
    const oldest = codexSessionIndexTitleCache.keys().next()
    if (!oldest.done) {
      codexSessionIndexTitleCache.delete(oldest.value)
    }
  }
}

async function readCodexSessionIndexTitlesFromDisk(
  indexPath: string
): Promise<{ titles: Map<string, IndexedTitle>; refused: boolean }> {
  const titleBySessionId = new Map<string, IndexedTitle>()
  try {
    const lines = createInterface({
      input: openTranscriptReadStream(indexPath, { encoding: 'utf-8' }, 'scan'),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        titleBySessionId.set(sessionId, { title, updatedAt: titleTimestamp(record.updated_at) })
      }
    }
  } catch (error) {
    // Codex creates the index opportunistically; older homes may only have raw transcripts.
    return { titles: titleBySessionId, refused: error instanceof WslTranscriptFsError }
  }
  return { titles: titleBySessionId, refused: false }
}

function titleTimestamp(value: unknown): bigint | null {
  if (typeof value !== 'string') {
    return null
  }
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) {
    return null
  }
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1] ?? ''
  return (
    BigInt(Math.floor(milliseconds / 1000)) * 1_000_000_000n +
    BigInt(fraction.padEnd(9, '0').slice(0, 9))
  )
}
