import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { JournalRowWriter } from './journal-row-writer'
import { JournalWriteQueue } from './journal-write-queue'
import { readJournalRowsAfter } from './journal-row-table'
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
      database = openTestJournalHostDatabase(root)
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

    it('prepares a receipt once from built rows, preserves its target, and leaves empty or failed plans unwritten', async () => {
      const { writer, committedRows } = writerHarness()
      database.db.exec('CREATE TABLE receipt_fact (sequence INTEGER)')
      const build = vi.fn(row)
      const write = vi.fn((db: JournalHostDatabase['db'], target?: JournalRow) => {
        if (!target) {
          throw new Error('missing receipt target')
        }
        db.prepare('INSERT INTO receipt_fact VALUES (?)').run(target.seq)
      })
      const committed = vi.fn(() => {
        expect(committedRows).toEqual([])
        expect(database.db.prepare('SELECT sequence FROM receipt_fact').get()?.sequence).toBe(2)
      })
      const prepare = vi.fn((rows: readonly JournalRow[]) => {
        expect(rows.map((value) => value.seq)).toEqual([1, 2])
        expect(readTestJournalRows(database.db, SESSION_ID, EPOCH)).toEqual([])
        return { write, committed }
      })
      await writer.enqueueRows(
        () => [build, build],
        prepare,
        (rows) => rows[1]
      )
      expect(build).toHaveBeenCalledTimes(2)
      expect(prepare).toHaveBeenCalledTimes(1)
      expect(write).toHaveBeenCalledTimes(1)
      expect(committed).toHaveBeenCalledTimes(1)
      expect(committedRows).toHaveLength(2)
      prepare.mockClear()
      await writer.enqueueRows(() => [], prepare)
      expect(prepare).not.toHaveBeenCalled()
      await expect(
        writer.enqueue(build, () => {
          throw new Error('prepare failed')
        })
      ).rejects.toThrow('prepare failed')
      expect(readTestJournalRows(database.db, SESSION_ID, EPOCH)).toHaveLength(2)
      await writer.enqueue(row)
      expect(committedRows.map((value) => value.seq)).toEqual([1, 2, 3])
    })

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

    it.each(['single', 'batch'] as const)(
      'keeps the save time separate from a pinned JSON timestamp in a %s write',
      async (kind) => {
        const { writer, committedRows } = writerHarness()
        const pinned = (seq: number) => row(seq, 0)
        await (kind === 'single'
          ? writer.enqueue(pinned)
          : writer.enqueueRows(() => [pinned, pinned]))

        const saved = readJournalRowsAfter(database.db, SESSION_ID, EPOCH, 0)
        expect(saved).toHaveLength(kind === 'single' ? 1 : 2)
        expect(saved.map((entry) => entry.ts)).toEqual(saved.map(() => 1))
        expect(saved.map((entry) => JSON.parse(entry.rowJson))).toEqual(committedRows)
        expect(committedRows.map((entry) => entry.ts)).toEqual(saved.map(() => 0))
      }
    )
  })
}
