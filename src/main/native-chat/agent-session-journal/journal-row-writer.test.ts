// The write path's transaction.
//
// A transaction either commits or does not, so the old "a post-append failure
// makes durability ambiguous" latch has nothing left to latch on: the case that
// used to assert the latch asserts the rollback instead.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import { openJournalDatabase, type OpenJournalDatabase } from './journal-database'
import { journalDatabaseFile } from './journal-paths'
import {
  insertJournalRow,
  readJournalEpochRows,
  upsertJournalSessionRow
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'

const SESSION_ID = 'session-1'
const EPOCH = 'epoch-1'

function row(seq: number, ts: number): JournalRow {
  return {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: EPOCH,
    seq,
    fence: 0,
    ts,
    kind: 'item',
    itemId: 'item-1',
    revision: 1,
    body: { kind: 'status', text: 'plain append' }
  }
}

describe('journal row writer', () => {
  let root: string
  let database: OpenJournalDatabase
  let readOnly = false

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-row-writer-'))
    database = openJournalDatabase(journalDatabaseFile(root))
    upsertJournalSessionRow(database.db, SESSION_ID, EPOCH, 1)
    readOnly = false
  })

  afterEach(async () => {
    try {
      database.db.close()
    } catch {
      // Already closed by the case.
    }
    await rm(root, { recursive: true, force: true })
  })

  function writerHarness() {
    const committedRows: JournalRow[] = []
    let sequence = 1
    const writer = new JournalRowWriter({
      sessionId: SESSION_ID,
      now: () => 1,
      serialize: (run) => run(),
      database: () => database,
      readOnly: () => readOnly,
      highestFence: () => 0,
      nextSequence: () => sequence,
      commit: (committed) => {
        committedRows.push(committed)
        sequence = committed.seq + 1
      }
    })
    return { writer, committedRows }
  }

  it('rolls the transaction back and sets no latch when the insert fails', async () => {
    const { writer, committedRows } = writerHarness()
    // A row already occupies sequence 1, so the insert violates the primary key.
    insertJournalRow(database.db, SESSION_ID, row(1, 1))

    await expect(writer.enqueue(row)).rejects.toThrow()

    expect(readOnly).toBe(false)
    expect(committedRows).toHaveLength(0)
    expect(readJournalEpochRows(database.db, SESSION_ID, EPOCH)).toHaveLength(1)
    // Still writable: there is no ambiguity for a latch to protect against.
    await expect(writer.enqueue((seq, ts) => row(seq + 1, ts))).resolves.toMatchObject({
      kind: 'item'
    })
  })
})
