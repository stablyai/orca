import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import { replayJournal } from './journal-open'
import { insertJournalRow, upsertJournalSessionRow } from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import * as reducer from './journal-reducer'

let root: string
let opened: OpenJournalDatabase
const sessionId = 'streaming-session'
const epoch = 'epoch-1'

function anchor(): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'epoch',
    epoch,
    seq: 1,
    ts: 1,
    fence: 1,
    reason: 'session_created',
    providerHandle: { kind: 'codex', threadId: 'thread-1' }
  }
}

function revision(seq: number, text = 'content'): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    kind: 'item',
    epoch,
    seq,
    ts: seq,
    fence: 1,
    itemId: 'message-1',
    revision: seq,
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  }
}

function put(row: JournalRow): void {
  insertJournalRow(opened.db, sessionId, row)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stream-replay-'))
  opened = openJournalDatabase(journalDatabaseFile(root))
  upsertJournalSessionRow(opened.db, sessionId, epoch, 1)
})

afterEach(async () => {
  vi.restoreAllMocks()
  opened.db.close()
  await rm(root, { recursive: true, force: true })
})

describe('streaming journal replay', () => {
  it('releases superseded revision bodies while reducing a long journal', () => {
    const gc = global.gc
    if (!gc) {
      throw new Error('Run retention tests with --expose-gc')
    }
    opened.db.exec('BEGIN')
    put(anchor())
    for (let seq = 2; seq <= 2049; seq++) {
      put(revision(seq, `${'x'.repeat(16384)}:${seq}`))
    }
    opened.db.exec('COMMIT')
    gc()
    const initial = process.memoryUsage().heapUsed
    let peak = initial
    let applied = 0
    const apply = reducer.applyJournalRow
    const spy = vi.spyOn(reducer, 'applyJournalRow')
    spy.mockImplementation((state, row) => {
      // The probe must not retain old row bodies in Vitest's call history.
      spy.mockClear()
      applied += 1
      if (row.seq % 256 === 0) {
        gc()
        peak = Math.max(peak, process.memoryUsage().heapUsed)
      }
      apply(state, row)
    })
    const loaded = replayJournal(opened.db, false, sessionId)!
    expect(loaded.state.items.size).toBe(1)
    expect(loaded.state.items.get('message-1')?.revision).toBe(2049)
    expect(loaded.state.lastSequence).toBe(2049)
    // The probe must have measured every row, or the heap bound above is vacuous.
    expect(applied).toBe(2049)
    expect(peak - initial).toBeLessThan(8 * 1024 * 1024)
  })

  it('holds no read snapshot while reducing, so a checkpoint can pass mid-replay', () => {
    put(anchor())
    for (let seq = 2; seq <= 300; seq++) {
      put(revision(seq))
    }
    const apply = reducer.applyJournalRow
    const checkpoints: { busy: number }[] = []
    vi.spyOn(reducer, 'applyJournalRow').mockImplementation((state, row) => {
      if (row.seq === 2 || row.seq === 200) {
        checkpoints.push(...(opened.db.pragma('wal_checkpoint(PASSIVE)') as { busy: number }[]))
      }
      apply(state, row)
    })
    const loaded = replayJournal(opened.db, false, sessionId)!
    expect(loaded.state.lastSequence).toBe(300)
    expect(checkpoints.map((entry) => entry.busy)).toEqual([0, 0])
  })

  it('keeps the prefix but latches read-only for a future row beyond a gap', () => {
    put(anchor())
    put(revision(2))
    put(revision(4))
    put({ ...revision(5), v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1 })
    const loaded = replayJournal(opened.db, false, sessionId)!
    expect(loaded).toMatchObject({ readOnly: true, corrupt: true, malformedRows: 0 })
    expect(loaded.truncateFrom).toBeUndefined()
    expect(loaded.state.items.get('message-1')?.revision).toBe(2)
    expect(loaded.state.lastSequence).toBe(2)
    const checkpoint = opened.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    expect(checkpoint[0].busy).toBe(0)
  })

  it('keeps gap repair precedence when a later row is malformed', () => {
    put(anchor())
    put(revision(2))
    put(revision(4))
    opened.db
      .prepare('INSERT INTO journal_rows VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, epoch, 5, 5, '{')
    const loaded = replayJournal(opened.db, false, sessionId)!
    expect(loaded).toMatchObject({
      readOnly: false,
      corrupt: true,
      malformedRows: 1,
      truncateFrom: 4
    })
    expect(loaded.state.lastSequence).toBe(2)
  })

  it('rejects an unanchored prefix before a later gap', () => {
    put(revision(1))
    put(revision(3))
    const loaded = replayJournal(opened.db, false, sessionId)!
    expect(loaded).toMatchObject({ readOnly: false, corrupt: true, truncateFrom: 1 })
    expect(loaded.state.items.size).toBe(0)
    expect(loaded.state.lastSequence).toBe(0)
  })
})
