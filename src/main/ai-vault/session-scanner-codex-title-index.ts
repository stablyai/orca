import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'
import { iterateAiVaultJsonlLines } from './session-jsonl-line-reader'

// Codex names threads lazily in <CODEX_HOME>/session_index.jsonl; transcripts
// carry no title of their own, so parsers look the thread name up here.

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'
// Misses fall back to an exact streaming lookup, so this only trades memory for scan time.
const CODEX_SESSION_INDEX_RETAINED_TITLE_MAX = 2_048
export const CODEX_SESSION_INDEX_CACHE_KEY_MAX_UTF8_BYTES = 32 * 1024
export const CODEX_SESSION_INDEX_SESSION_ID_MAX_UTF8_BYTES = 64 * 1024
export const CODEX_SESSION_INDEX_RETAINED_UTF8_BYTES_MAX = 512 * 1024
const CODEX_SESSION_INDEX_TITLE_MAX_UTF8_BYTES = 4 * 1024
const CODEX_SESSION_INDEX_ENTRY_OVERHEAD_BYTES = 64
// Why: custom and WSL Codex homes can vary over a long-lived main process;
// each cached home can retain its own session_index title map.
export const CODEX_SESSION_INDEX_TITLE_CACHE_MAX = 64

type CodexSessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const codexSessionIndexTitleCache = new Map<string, Promise<CodexSessionIndexTitleCacheEntry>>()
const retainedBytesByTitleMap = new WeakMap<Map<string, string>, number>()

export function resetCodexSessionIndexTitleCacheForTests(): void {
  codexSessionIndexTitleCache.clear()
}

export function _getCodexSessionIndexTitleCacheSizeForTest(): number {
  return codexSessionIndexTitleCache.size
}

export function _hasCodexSessionIndexTitleCacheEntryForTest(codexHome: string): boolean {
  return codexSessionIndexTitleCache.has(codexHome)
}

export async function _getCodexSessionIndexRetainedTitleCountForTest(
  codexHome: string
): Promise<number> {
  return (await codexSessionIndexTitleCache.get(codexHome))?.titles.size ?? 0
}

export function _storeCodexSessionIndexTitleCacheEntryForTest(
  codexHome: string,
  signature: string,
  titles: Promise<Map<string, string>>
): void {
  storeCodexSessionIndexTitleCacheEntry(
    codexHome,
    titles.then((resolvedTitles) => ({ signature, titles: resolvedTitles }))
  )
}

export function _readCachedCodexSessionIndexTitlesForTest(
  codexHome: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  return readCachedCodexSessionIndexTitles(codexHome, signature)
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
  const titleBySessionId = await readCodexSessionIndexTitles(resolvedCodexHome)
  const cachedTitle = titleBySessionId.get(sessionId)
  if (cachedTitle) {
    return cachedTitle
  }

  // Why: the retained map is capped, but an older requested session must still
  // get the same title as before the cap.
  const title = await readCodexSessionIndexTitleFromDisk(
    join(resolvedCodexHome, CODEX_SESSION_INDEX_FILE),
    sessionId
  )
  if (title) {
    retainCodexSessionIndexTitle(titleBySessionId, sessionId, title)
  }
  return title
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

async function readCodexSessionIndexTitles(codexHome: string): Promise<Map<string, string>> {
  const indexPath = join(codexHome, CODEX_SESSION_INDEX_FILE)
  let signature: string
  try {
    const indexStat = await stat(indexPath)
    signature = `${indexStat.size}:${indexStat.mtimeMs}`
  } catch {
    return new Map()
  }

  const cachedTitles = await readCachedCodexSessionIndexTitles(codexHome, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const pending = readCodexSessionIndexTitlesFromDisk(indexPath).then((titles) => ({
    signature,
    titles
  }))
  storeCodexSessionIndexTitleCacheEntry(codexHome, pending)
  return (await pending).titles
}

async function readCachedCodexSessionIndexTitles(
  codexHome: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  const cached = codexSessionIndexTitleCache.get(codexHome)
  if (!cached) {
    return undefined
  }
  const entry = await cached
  if (entry.signature !== signature) {
    return undefined
  }
  // Why: another scan can evict or replace this Promise while it resolves;
  // only the still-current entry may refresh recency without bypassing the cap.
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
  if (Buffer.byteLength(codexHome, 'utf8') > CODEX_SESSION_INDEX_CACHE_KEY_MAX_UTF8_BYTES) {
    return
  }
  const boundedPending = pending.then((entry) => {
    boundCodexSessionIndexTitles(entry.titles)
    return entry
  })
  codexSessionIndexTitleCache.delete(codexHome)
  codexSessionIndexTitleCache.set(codexHome, boundedPending)
  if (codexSessionIndexTitleCache.size > CODEX_SESSION_INDEX_TITLE_CACHE_MAX) {
    const oldest = codexSessionIndexTitleCache.keys().next()
    if (!oldest.done) {
      codexSessionIndexTitleCache.delete(oldest.value)
    }
  }
}

async function readCodexSessionIndexTitlesFromDisk(
  indexPath: string
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    const lines = iterateAiVaultJsonlLines(indexPath)
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      const sessionId = extractString(record.id)
      const title = normalizeTitleText(extractString(record.thread_name) ?? '')
      if (sessionId && title) {
        retainCodexSessionIndexTitle(titleBySessionId, sessionId, title)
      }
    }
  } catch {
    // Codex creates the index opportunistically; older homes may only have raw transcripts.
  }
  return titleBySessionId
}

async function readCodexSessionIndexTitleFromDisk(
  indexPath: string,
  requestedSessionId: string
): Promise<string | null> {
  let requestedTitle: string | null = null
  try {
    for await (const line of iterateAiVaultJsonlLines(indexPath)) {
      const record = parseJsonObject(line)
      if (record && extractString(record.id) === requestedSessionId) {
        requestedTitle =
          normalizeTitleText(extractString(record.thread_name) ?? '') ?? requestedTitle
      }
    }
  } catch {
    // Match the best-effort behavior of the full index read.
  }
  return requestedTitle
}

export function retainCodexSessionIndexTitle(
  titles: Map<string, string>,
  sessionId: string,
  title: string
): void {
  boundCodexSessionIndexTitles(titles)
  const sessionIdBytes = Buffer.byteLength(sessionId, 'utf8')
  const titleBytes = Buffer.byteLength(title, 'utf8')
  if (
    sessionIdBytes > CODEX_SESSION_INDEX_SESSION_ID_MAX_UTF8_BYTES ||
    titleBytes > CODEX_SESSION_INDEX_TITLE_MAX_UTF8_BYTES
  ) {
    return
  }
  let retainedBytes = retainedBytesByTitleMap.get(titles) ?? 0
  const existing = titles.get(sessionId)
  if (existing !== undefined) {
    retainedBytes -= codexTitleEntryBytes(sessionId, existing)
  }
  titles.delete(sessionId)
  const entryBytes = sessionIdBytes + titleBytes + CODEX_SESSION_INDEX_ENTRY_OVERHEAD_BYTES
  while (
    titles.size >= CODEX_SESSION_INDEX_RETAINED_TITLE_MAX ||
    retainedBytes + entryBytes > CODEX_SESSION_INDEX_RETAINED_UTF8_BYTES_MAX
  ) {
    const oldest = titles.entries().next().value
    if (!oldest) {
      break
    }
    titles.delete(oldest[0])
    retainedBytes -= codexTitleEntryBytes(oldest[0], oldest[1])
  }
  titles.set(sessionId, title)
  retainedBytesByTitleMap.set(titles, retainedBytes + entryBytes)
}

function boundCodexSessionIndexTitles(titles: Map<string, string>): void {
  if (retainedBytesByTitleMap.has(titles)) {
    return
  }
  const entries = [...titles]
  titles.clear()
  retainedBytesByTitleMap.set(titles, 0)
  for (const [sessionId, title] of entries) {
    retainCodexSessionIndexTitle(titles, sessionId, title)
  }
}

function codexTitleEntryBytes(sessionId: string, title: string): number {
  return (
    Buffer.byteLength(sessionId, 'utf8') +
    Buffer.byteLength(title, 'utf8') +
    CODEX_SESSION_INDEX_ENTRY_OVERHEAD_BYTES
  )
}
