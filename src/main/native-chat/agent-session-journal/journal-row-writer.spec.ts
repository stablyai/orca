import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { TestJournalHostDatabase as JournalHostDatabase } from './journal-host-database-test-support'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import {
  openTestJournalHostDatabase,
  readTestJournalRows,
  insertTestJournalRow,
  publishTestJournalEpoch
} from './journal-host-database-test-support'

export function registerJournalRowWriterTests(): void {
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
    let database: JournalHostDatabase
    let readOnly = false

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'orca-journal-row-writer-'))
      database = await openTestJournalHostDatabase(root)
      publishTestJournalEpoch(database.db, SESSION_ID, EPOCH)
      readOnly = false
    })

    afterEach(async () => {
      try {
        await database.close()
      } catch {}
      await rm(root, { recursive: true, force: true })
    })

    function writerHarness() {
      const committedRows: JournalRow[] = []
      let sequence = 1
      const queue = new JournalWriteQueue(SESSION_ID)
      const writer = new JournalRowWriter({
        sessionId: SESSION_ID,
        now: () => 1,
        serialize: (run) => queue.serialize(run),
        database: () => database,
        readOnly: () => readOnly,
        highestFence: () => 0,
        nextSequence: () => sequence,
        commit: (committed) => {
          committedRows.push(...committed)
          sequence = committed.at(-1)!.seq + 1
        }
      })
      return { writer, committedRows }
    }

    it('rolls the transaction back and sets no latch when the insert fails', async () => {
      const { writer, committedRows } = writerHarness()
      insertTestJournalRow(database.db, SESSION_ID, row(1, 1))

      await expect(writer.enqueue(row)).rejects.toThrow()

      expect(readOnly).toBe(false)
      expect(committedRows).toHaveLength(0)
      expect(readTestJournalRows(database.db, SESSION_ID, EPOCH)).toHaveLength(1)
      // Rolled-back inserts leave the writer usable.
      await expect(writer.enqueue((seq, ts) => row(seq + 1, ts))).resolves.toMatchObject({
        kind: 'item'
      })
    })

    it('writes several rows as one: a failure on the last leaves none', async () => {
      const { writer, committedRows } = writerHarness()
      insertTestJournalRow(database.db, SESSION_ID, row(2, 1))

      await expect(writer.enqueueRows(() => [row, row])).rejects.toThrow()

      expect(committedRows).toHaveLength(0)
      expect(
        readTestJournalRows(database.db, SESSION_ID, EPOCH).map((stored) => stored.seq)
      ).toEqual([2])
    })
  })
}
