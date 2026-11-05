import { basename, dirname, join } from 'node:path'
import type { Stats } from 'node:fs'
import { readCodexIndexUpdate, type CodexIndexRead } from './session-scanner-codex-index-read'
import {
  InFlightPromiseDedupe,
  stableInFlightKey
} from '../../../../shared/in-flight-promise-dedupe'
import { wslGatedStat } from '../../../native-chat/wsl-transcript-fs-access'

// Thread names may arrive here after the transcript was written.

const CODEX_SESSION_INDEX_FILE = 'session_index.jsonl'
// Bound full title maps retained for custom and WSL homes across a long-lived process.
const CODEX_SESSION_INDEX_TITLE_CACHE_MAX = 64

type CodexSessionIndexTitleCacheEntry = {
  signature: string
  titles: Map<string, string>
  read?: CodexIndexRead
}

const codexSessionIndexTitleCache = new Map<string, Promise<CodexSessionIndexTitleCacheEntry>>()
const inFlightTitleReads = new InFlightPromiseDedupe<Map<string, string>>(
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

export function codexHomeFromSessionFilePath(sessionFilePath: string): string | null {
  let currentDir = dirname(sessionFilePath)
  while (currentDir && dirname(currentDir) !== currentDir) {
    if (basename(currentDir) === 'sessions') {
      return dirname(currentDir)
    }
    currentDir = dirname(currentDir)
  }
  return null
}

export async function readCodexSessionIndexTitles(codexHome: string): Promise<Map<string, string>> {
  const indexPath = join(codexHome, CODEX_SESSION_INDEX_FILE)
  let signature: string
  let indexStat: Stats
  try {
    indexStat = await wslGatedStat(indexPath, 'scan')
    signature = `${indexStat.dev}:${indexStat.ino}:${indexStat.size}:${indexStat.mtimeMs}:${indexStat.ctimeMs}`
  } catch {
    return new Map()
  }

  const cachedTitles = await readCachedCodexSessionIndexTitles(codexHome, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  // A shared WSL stat resumes cache misses together; share the reload before opening the index.
  return inFlightTitleReads.run(stableInFlightKey([codexHome, signature]), () =>
    loadCodexSessionIndexTitles(codexHome, indexPath, signature, indexStat)
  )
}

async function loadCodexSessionIndexTitles(
  codexHome: string,
  indexPath: string,
  signature: string,
  indexStat: Stats
): Promise<Map<string, string>> {
  const cachedTitles = await readCachedCodexSessionIndexTitles(codexHome, signature)
  if (cachedTitles) {
    return cachedTitles
  }

  const previous = await codexSessionIndexTitleCache.get(codexHome)
  const pending = readCodexIndexUpdate(indexPath, indexStat, previous?.read).then(
    (read) => ({ signature, titles: read.titles, read }),
    () => {
      // Failed reads must retry even if the file signature stays unchanged.
      if (codexSessionIndexTitleCache.get(codexHome) === pending) {
        codexSessionIndexTitleCache.delete(codexHome)
      }
      return { signature, titles: new Map<string, string>() }
    }
  )
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
