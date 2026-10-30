import { mkdir, mkdtemp, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SyncDatabase from '../sqlite/sync-database'
import { isolatedScanRoots } from '../ai-vault/session-scanner-test-fixtures'
import type { SessionSearchClock, SessionSearchTimerHandle } from './session-search-clock'
import type { SessionSearchScanRoots } from './session-search-scan-roots'
import { assistantRecord, userRecord } from './session-search-transcript-fixtures'

const CLOCK_EPOCH_MS = 1_740_000_000_000

export class FakeSessionSearchClock implements SessionSearchClock {
  private time = CLOCK_EPOCH_MS
  private nextId = 1
  private nowCalls = 0
  private readonly timers = new Map<number, { at: number; callback: () => void }>()

  /** Simulate elapsed work at each now() call without waiting. */
  costPerNowMs = 0

  onNow: ((call: number) => void) | null = null

  now(): number {
    const at = this.time
    this.time += this.costPerNowMs
    this.onNow?.(++this.nowCalls)
    return at
  }

  setTimeout(callback: () => void, ms: number): SessionSearchTimerHandle {
    const id = this.nextId++
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }

  clearTimeout(handle: SessionSearchTimerHandle): void {
    this.timers.delete(handle as number)
  }

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
  read: <T>(query: (db: SyncDatabase) => T) => T
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

/** Replace by rename with equal byte length to require filesystem-identity detection. */
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
