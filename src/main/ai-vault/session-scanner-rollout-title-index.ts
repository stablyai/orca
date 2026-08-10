import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

const SESSION_INDEX_FILE = 'session_index.jsonl'
const SESSION_INDEX_TITLE_CACHE_MAX = 64

type SessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const sessionIndexTitleCache = new Map<string, Promise<SessionIndexTitleCacheEntry>>()

export function resetRolloutSessionIndexTitleCacheForTests(): void {
  sessionIndexTitleCache.clear()
}

export function _getRolloutSessionIndexTitleCacheSizeForTest(): number {
  return sessionIndexTitleCache.size
}

export function _hasRolloutSessionIndexTitleCacheEntryForTest(indexPath: string): boolean {
  return sessionIndexTitleCache.has(resolve(indexPath))
}

export function _storeRolloutSessionIndexTitleCacheEntryForTest(
  indexPath: string,
  signature: string,
  titles: Promise<Map<string, string>>
): void {
  storeSessionIndexTitleCacheEntry(
    resolve(indexPath),
    titles.then((resolvedTitles) => ({ signature, titles: resolvedTitles }))
  )
}

export function _readCachedRolloutSessionIndexTitlesForTest(
  indexPath: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  return readCachedSessionIndexTitles(resolve(indexPath), signature)
}

export async function readRolloutSessionIndexTitle(args: {
  sessionFilePath: string
  sessionHome: string | null
  sessionId: string
}): Promise<string | null> {
  const home = args.sessionHome ?? sessionHomeFromRolloutPath(args.sessionFilePath)
  if (!home) {
    return null
  }
  return (
    (await readSessionIndexTitles(resolve(home, SESSION_INDEX_FILE))).get(args.sessionId) ?? null
  )
}

function sessionHomeFromRolloutPath(sessionFilePath: string): string | null {
  let currentDir = dirname(sessionFilePath)
  while (currentDir && dirname(currentDir) !== currentDir) {
    if (basename(currentDir) === 'sessions') {
      return dirname(currentDir)
    }
    currentDir = dirname(currentDir)
  }
  return null
}

async function readSessionIndexTitles(indexPath: string): Promise<Map<string, string>> {
  let signature: string
  try {
    const indexStat = await stat(indexPath)
    signature = `${indexStat.size}:${indexStat.mtimeMs}`
  } catch {
    return new Map()
  }

  const cachedTitles = await readCachedSessionIndexTitles(indexPath, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const pending = readSessionIndexTitlesFromDisk(indexPath).then((titles) => ({
    signature,
    titles
  }))
  storeSessionIndexTitleCacheEntry(indexPath, pending)
  return (await pending).titles
}

async function readCachedSessionIndexTitles(
  indexPath: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  const cached = sessionIndexTitleCache.get(indexPath)
  if (!cached) {
    return undefined
  }
  const entry = await cached
  if (entry.signature !== signature) {
    return undefined
  }
  if (sessionIndexTitleCache.get(indexPath) === cached) {
    sessionIndexTitleCache.delete(indexPath)
    sessionIndexTitleCache.set(indexPath, cached)
  }
  return entry.titles
}

function storeSessionIndexTitleCacheEntry(
  indexPath: string,
  pending: Promise<SessionIndexTitleCacheEntry>
): void {
  sessionIndexTitleCache.delete(indexPath)
  sessionIndexTitleCache.set(indexPath, pending)
  if (sessionIndexTitleCache.size > SESSION_INDEX_TITLE_CACHE_MAX) {
    const oldest = sessionIndexTitleCache.keys().next()
    if (!oldest.done) {
      sessionIndexTitleCache.delete(oldest.value)
    }
  }
}

async function readSessionIndexTitlesFromDisk(indexPath: string): Promise<Map<string, string>> {
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
    // Session indexes are optional; raw rollout transcripts remain usable.
  }
  return titleBySessionId
}
