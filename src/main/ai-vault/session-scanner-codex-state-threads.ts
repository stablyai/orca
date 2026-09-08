import { isWslUncPath } from '../../shared/wsl-paths'
import { findNewestCodexStateDbPath } from '../codex/codex-state-db'
import { wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import SyncDatabase from '../sqlite/sync-database'
import { timestampIso } from './session-scanner-accumulator'
import type { SessionAccumulator } from './session-scanner-types'
import { normalizeTitleText } from './session-scanner-values'

// Codex mirrors every rollout into <CODEX_HOME>/state_<n>.sqlite `threads`, which
// also covers threads whose transcript never recorded a session_meta record.

export type CodexStateThreadMetadata = {
  title: string | null
  cwd: string | null
  branch: string | null
  updatedAt: string | null
}

// Local-only: the state DB sits beside a local Codex home, so remote content
// parses leave this undefined and keep the session_index title path alone.
export type CodexStateThreadReader = (threadId: string) => Promise<CodexStateThreadMetadata | null>

// Why: a running Codex holds write locks; a short bound keeps a busy DB from
// stalling the scan instead of degrading to "no fallback".
const CODEX_STATE_DB_BUSY_TIMEOUT_MS = 250
// Why: the point is covering thousands of rollouts, but an unbounded read would
// retain every row of a pathological home in memory.
const CODEX_STATE_DB_THREAD_LIMIT = 20_000
// Why: `title` holds the full first user message (tens of KB per row here).
const CODEX_STATE_DB_TITLE_CHARS = 200
const CODEX_STATE_THREAD_CACHE_MAX = 8

const CODEX_STATE_THREAD_QUERY = `SELECT id, name, substr(title, 1, ${CODEX_STATE_DB_TITLE_CHARS}) AS title, cwd, git_branch, updated_at_ms, updated_at
FROM threads
ORDER BY updated_at DESC
LIMIT ${CODEX_STATE_DB_THREAD_LIMIT}`

type CodexStateThreadCacheEntry = {
  signature: string
  threads: Map<string, CodexStateThreadMetadata>
}

const codexStateThreadCache = new Map<string, Promise<CodexStateThreadCacheEntry>>()

export function resetCodexStateThreadCacheForTests(): void {
  codexStateThreadCache.clear()
}

export async function readCodexStateThreadMetadata(
  codexHome: string | null,
  threadId: string
): Promise<CodexStateThreadMetadata | null> {
  if (!codexHome || !threadId) {
    return null
  }
  const threads = await readCodexStateThreads(codexHome)
  return threads.get(threadId) ?? null
}

/** Fills only what the rollout itself never recorded; the transcript always wins. */
export async function applyCodexStateThreadFallback(
  accumulator: SessionAccumulator,
  stateThreadReader?: CodexStateThreadReader
): Promise<void> {
  const needsTitle = !accumulator.title && !accumulator.fallbackTitle
  if (
    !stateThreadReader ||
    (accumulator.cwd && accumulator.branch && accumulator.updatedAt && !needsTitle)
  ) {
    return
  }
  const metadata = await stateThreadReader(accumulator.sessionId)
  if (!metadata) {
    return
  }
  if (needsTitle) {
    accumulator.title ??= metadata.title
  }
  accumulator.cwd ??= metadata.cwd
  accumulator.branch ??= metadata.branch
  accumulator.updatedAt ??= metadata.updatedAt
}

async function readCodexStateThreads(
  codexHome: string
): Promise<Map<string, CodexStateThreadMetadata>> {
  // Why: SQLite over the \\wsl$ redirector blocks the gated fs queue and has no
  // working locking; WSL homes keep the session_index title path only.
  if (isWslUncPath(codexHome)) {
    return new Map()
  }
  const stateDbPath = findNewestCodexStateDbPath(codexHome)
  if (!stateDbPath) {
    return new Map()
  }
  const signature = await readCodexStateDbSignature(stateDbPath)
  if (!signature) {
    return new Map()
  }
  const cached = await readCachedCodexStateThreads(codexHome, signature)
  if (cached) {
    return cached
  }
  const threads = readCodexStateThreadsFromDisk(stateDbPath)
  storeCodexStateThreadCacheEntry(codexHome, Promise.resolve({ signature, threads }))
  return threads
}

async function readCodexStateDbSignature(stateDbPath: string): Promise<string | null> {
  let dbStat
  try {
    dbStat = await wslGatedStat(stateDbPath, 'scan')
  } catch {
    return null
  }
  // Why: in WAL mode the main file's mtime barely moves, so without the -wal
  // stat the cache would pin a stale thread map for the process lifetime.
  let walSuffix = ''
  try {
    const walStat = await wslGatedStat(`${stateDbPath}-wal`, 'scan')
    walSuffix = `:${walStat.size}:${walStat.mtimeMs}`
  } catch {
    walSuffix = ''
  }
  return `${dbStat.size}:${dbStat.mtimeMs}${walSuffix}`
}

async function readCachedCodexStateThreads(
  codexHome: string,
  signature: string
): Promise<Map<string, CodexStateThreadMetadata> | undefined> {
  const cached = codexStateThreadCache.get(codexHome)
  if (!cached) {
    return undefined
  }
  const entry = await cached
  if (entry.signature !== signature) {
    return undefined
  }
  // Why: a concurrent scan can replace this Promise while it resolves; only the
  // still-current entry may refresh recency without bypassing the cap.
  if (codexStateThreadCache.get(codexHome) === cached) {
    codexStateThreadCache.delete(codexHome)
    codexStateThreadCache.set(codexHome, cached)
  }
  return entry.threads
}

function storeCodexStateThreadCacheEntry(
  codexHome: string,
  pending: Promise<CodexStateThreadCacheEntry>
): void {
  codexStateThreadCache.delete(codexHome)
  codexStateThreadCache.set(codexHome, pending)
  if (codexStateThreadCache.size > CODEX_STATE_THREAD_CACHE_MAX) {
    const oldest = codexStateThreadCache.keys().next()
    if (!oldest.done) {
      codexStateThreadCache.delete(oldest.value)
    }
  }
}

function readCodexStateThreadsFromDisk(stateDbPath: string): Map<string, CodexStateThreadMetadata> {
  const threads = new Map<string, CodexStateThreadMetadata>()
  let db: SyncDatabase | null = null
  try {
    db = new SyncDatabase(stateDbPath, {
      readonly: true,
      fileMustExist: true,
      timeout: CODEX_STATE_DB_BUSY_TIMEOUT_MS
    })
    for (const row of db.prepare(CODEX_STATE_THREAD_QUERY).all()) {
      const threadId = readTrimmedColumn(row.id)
      if (threadId && !threads.has(threadId)) {
        threads.set(threadId, threadMetadataFromRow(row))
      }
    }
  } catch {
    // A locked, missing, or schema-drifted state DB means no fallback, never a failed scan.
    return new Map()
  } finally {
    try {
      db?.close()
    } catch {
      // A close failure cannot change the rows already collected.
    }
  }
  return threads
}

function threadMetadataFromRow(row: Record<string, unknown>): CodexStateThreadMetadata {
  return {
    title:
      normalizeTitleText(readTrimmedColumn(row.name) ?? '') ??
      normalizeTitleText(readTrimmedColumn(row.title) ?? ''),
    cwd: readTrimmedColumn(row.cwd),
    branch: readTrimmedColumn(row.git_branch),
    updatedAt: timestampIso(row.updated_at_ms) ?? timestampIso(row.updated_at)
  }
}

function readTrimmedColumn(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
