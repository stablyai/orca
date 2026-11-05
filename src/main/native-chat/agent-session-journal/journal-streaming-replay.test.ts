import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { TestJournalHostDatabase as JournalHostDatabase } from './journal-host-database-test-support'
import { replayJournal } from './journal-open'
import type { JournalRow } from './journal-row-schema'
import {
  openTestJournalHostDatabase,
  insertTestJournalRow,
  publishTestJournalEpoch,
  insertTestJournalRowJson
} from './journal-host-database-test-support'

let root: string
let opened: JournalHostDatabase
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
  insertTestJournalRow(opened.db, sessionId, row)
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-stream-replay-'))
  opened = await openTestJournalHostDatabase(root)
  publishTestJournalEpoch(opened.db, sessionId, epoch)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await opened.close()
  await rm(root, { recursive: true, force: true })
})

describe('streaming journal replay', () => {
  it('reads past a gap to a future row, which names the newer row and no damage', () => {
    put(anchor())
    put(revision(2))
    put(revision(4))
    put({ ...revision(5), v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION + 1 })
    const loaded = replayJournal(opened.db, sessionId)!
    expect(loaded).toMatchObject({ newer: { sequence: 5 }, damage: null })
    expect(loaded.state.items.get('message-1')?.revision).toBe(2)
    expect(loaded.state.lastSequence).toBe(2)
    const checkpoint = opened.db.pragma('wal_checkpoint(TRUNCATE)') as { busy: number }[]
    expect(checkpoint[0].busy).toBe(0)
  })

  it('names the first damage when a later row is malformed too', () => {
    put(anchor())
    put(revision(2))
    put(revision(4))
    insertTestJournalRowJson(opened.db, sessionId, 5, '{')
    const loaded = replayJournal(opened.db, sessionId)!
    expect(loaded).toMatchObject({
      newer: null,
      damage: { sequence: 3, cause: 'sequence-gap' }
    })
    expect(loaded.state.lastSequence).toBe(2)
  })

  it('names a missing epoch row before a later gap', () => {
    put(revision(1))
    put(revision(3))
    const loaded = replayJournal(opened.db, sessionId)!
    expect(loaded).toMatchObject({
      newer: null,
      damage: { sequence: 1, cause: 'no-epoch-row' }
    })
    expect(loaded.state.items.size).toBe(0)
    expect(loaded.state.lastSequence).toBe(0)
  })
})
