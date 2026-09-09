import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import type { SessionSearchClock, SessionSearchTimerHandle } from './session-search-clock'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { assistantRecord, userRecord } from './session-search-transcript-fixtures'

const CLOCK_EPOCH_MS = 1_740_000_000_000

/** Wall time the indexer's guarantee is stated in, under the test's control. */
export class FakeSessionSearchClock implements SessionSearchClock {
  private time = CLOCK_EPOCH_MS
  private nextId = 1
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  now(): number {
    return this.time
  }

  setTimeout(callback: () => void, ms: number): SessionSearchTimerHandle {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: SessionSearchTimerHandle): void {
    this.timers.delete(handle as number)
  }

  /** Moves time forward and fires every timer that came due, in order. */
  advance(ms: number): void {
    this.time += ms
    for (const [id, timer] of [...this.timers].sort((left, right) => left[1].at - right[1].at)) {
      if (timer.at <= this.time) {
        this.timers.delete(id)
        timer.callback()
      }
    }
  }

  get pendingTimers(): number {
    return this.timers.size
  }
}

export type SessionSearchIndexerHarness = {
  root: string
  databasePath: string
  roots: SessionSearchScanRoots
  claudeProjectDir: string
  /** A second connection: the store keeps its own private. */
  read: <T>(query: (db: SyncDatabase) => T) => T
  /** Plants what a killed writer would have left; nothing in the app writes here. */
  write: <T>(query: (db: SyncDatabase) => T) => T
  cleanup: () => Promise<void>
}

export async function openSessionSearchIndexerHarness(
  name: string
): Promise<SessionSearchIndexerHarness> {
  const root = await mkdtemp(join(tmpdir(), `${name}-`))
  const roots = isolatedScanRoots(root)
  const databasePath = join(root, 'index', 'index.sqlite')
  return {
    root,
    databasePath,
    roots,
    claudeProjectDir: join(roots.claudeProjectsDir, 'project'),
    read: (query) => withConnection(databasePath, true, query),
    write: (query) => withConnection(databasePath, false, query),
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}

function withConnection<T>(
  path: string,
  readonlyConnection: boolean,
  query: (db: SyncDatabase) => T
): T {
  const db = new SyncDatabase(path, { readonly: readonlyConnection })
  try {
    return query(db)
  } finally {
    db.close()
  }
}

/** A native-chat-shaped Claude transcript: the same records the app itself writes. */
export async function writeClaudeTranscript(
  path: string,
  turns: readonly string[],
  sessionId: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${claudeLines(turns, sessionId, 0).join('\n')}\n`)
}

export function claudeLines(
  turns: readonly string[],
  sessionId: string,
  startIndex: number
): string[] {
  return turns.flatMap((turn, offset) => [
    userRecord(startIndex + offset * 2, turn, sessionId),
    assistantRecord(startIndex + offset * 2 + 1, `noted: ${turn}`, sessionId)
  ])
}

/**
 * Replaces a transcript the way an editor or a sync client does: a new inode
 * renamed over the old name. Same byte length on purpose, so the only thing
 * that can tell the two files apart is their filesystem identity.
 */
export async function renameReplaceTranscript(
  path: string,
  turns: readonly string[],
  sessionId: string
): Promise<void> {
  const before = await stat(path)
  const replacement = `${path}.replacement`
  await writeClaudeTranscript(replacement, turns, sessionId)
  await rename(replacement, path)
  const later = new Date(before.mtimeMs + 5_000)
  await utimes(path, later, later)
}

/**
 * A message-graph transcript, the shape OpenClaw, Pi, OMP and Prime Agent
 * write. The session id comes from the file name, so callers name the file.
 */
export async function writeMessageGraphTranscript(
  path: string,
  turns: readonly string[]
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const lines = turns.flatMap((turn, index) => [
    JSON.stringify({
      type: 'message',
      timestamp: new Date(CLOCK_EPOCH_MS + index * 120_000).toISOString(),
      message: { role: 'user', content: turn }
    }),
    JSON.stringify({
      type: 'message',
      timestamp: new Date(CLOCK_EPOCH_MS + index * 120_000 + 60_000).toISOString(),
      message: { role: 'assistant', content: `noted: ${turn}` }
    })
  ])
  await writeFile(path, `${lines.join('\n')}\n`)
}
