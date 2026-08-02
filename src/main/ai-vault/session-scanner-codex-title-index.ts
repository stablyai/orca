import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

// Codex names threads lazily in <CODEX_HOME>/session_index.jsonl; transcripts
// carry no title of their own, so parsers look the thread name up here.

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'
// Why: custom and WSL Codex homes can vary over a long-lived main process;
// each cached home can retain a full session_index title map.
const CODEX_SESSION_INDEX_TITLE_CACHE_MAX = 64

type CodexSessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const codexSessionIndexTitleCache = new Map<string, Promise<CodexSessionIndexTitleCacheEntry>>()

export function resetCodexSessionIndexTitleCacheForTests(): void {
  codexSessionIndexTitleCache.clear()
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
  return titleBySessionId.get(sessionId) ?? null
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
): Promise<Map<string, string>> {
  const titleBySessionId = new Map<string, string>()
  try {
    const lines = createInterface({
      input: createReadStream(indexPath, { encoding: 'utf-8' }),
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
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch {
    // Codex creates the index opportunistically; older homes may only have raw transcripts.
  }
  return titleBySessionId
}
