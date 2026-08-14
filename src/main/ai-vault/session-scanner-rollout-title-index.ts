import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline'
import { resolveRuntimePath } from '../../shared/cross-platform-path'
import { openTranscriptReadStream, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { extractString, normalizeTitleText, parseJsonObject } from './session-scanner-values'

const SESSION_INDEX_FILE = 'session_index.jsonl'
const SESSION_INDEX_TITLE_CACHE_MAX = 64

type SessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
}

const sessionIndexTitleCache = new Map<string, Promise<SessionIndexTitleCacheEntry>>()

function sessionIndexCacheKey(indexPath: string): string {
  return resolveRuntimePath(process.cwd(), indexPath)
}

export function resetRolloutSessionIndexTitleCacheForTests(): void {
  sessionIndexTitleCache.clear()
}

export function _getRolloutSessionIndexTitleCacheSizeForTest(): number {
  return sessionIndexTitleCache.size
}

export function _hasRolloutSessionIndexTitleCacheEntryForTest(indexPath: string): boolean {
  return sessionIndexTitleCache.has(sessionIndexCacheKey(indexPath))
}

export function _storeRolloutSessionIndexTitleCacheEntryForTest(
  indexPath: string,
  signature: string,
  titles: Promise<Map<string, string>>
): void {
  storeSessionIndexTitleCacheEntry(
    sessionIndexCacheKey(indexPath),
    titles.then((resolvedTitles) => ({ signature, titles: resolvedTitles }))
  )
}

export function _readCachedRolloutSessionIndexTitlesForTest(
  indexPath: string,
  signature: string
): Promise<Map<string, string> | undefined> {
  return readCachedSessionIndexTitles(sessionIndexCacheKey(indexPath), signature)
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
  const indexPath = resolveRuntimePath(home, SESSION_INDEX_FILE)
  return (await readSessionIndexTitles(indexPath)).get(args.sessionId) ?? null
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
    const indexStat = await wslGatedStat(indexPath, 'scan')
    signature = `${indexStat.size}:${indexStat.mtimeMs}`
  } catch {
    return new Map()
  }

  const cachedTitles = await readCachedSessionIndexTitles(indexPath, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const pending = readSessionIndexTitlesFromDisk(indexPath).then(({ titles, refused }) => {
    if (refused && sessionIndexTitleCache.get(indexPath) === pending) {
      sessionIndexTitleCache.delete(indexPath)
    }
    return { signature, titles }
  })
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

async function readSessionIndexTitlesFromDisk(
  indexPath: string
): Promise<{ titles: Map<string, string>; refused: boolean }> {
  const titleBySessionId = new Map<string, string>()
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
        titleBySessionId.set(sessionId, title)
      }
    }
  } catch (error) {
    // Session indexes are optional; raw rollout transcripts remain usable.
    return { titles: titleBySessionId, refused: error instanceof WslTranscriptFsError }
  }
  return { titles: titleBySessionId, refused: false }
}
