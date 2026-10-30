import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  liveTestJournalRows,
  publishTestJournalEpoch,
  insertTestJournalRow
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import { journalOutcomeSource } from './journal-outcome-format'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { restoreJournal } from './journal-open'
import { parseJournalRow } from './journal-row-schema'
import type { JournalRow } from './journal-row-schema'
import { publishNewEpoch } from './journal-epoch-rollover'
import { encodeJournalState } from './journal-state-codec'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  seedProjectionRows,
  seedOutcomeRows,
  projectionWriter,
  finishCatchUp,
  unpacedCatchUp,
  expectProjectionMatches
} from './journal-projection-test-support'

let root: string
let database: JournalHostDatabase
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcomes-conversion-'))
  database = openTestJournalHostDatabase(root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.projection.close()
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})
const item = (seq: number): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId: 'stream',
  revision: seq,
  body: { kind: 'status', text: `revision ${seq}` }
})

it('publishes a compact generation only at a verified input tail, sweeps interruptions, and cancels on epoch replacement', async () => {
  seedProjectionRows(database, [
    projectionEpochRow,
    ...Array.from({ length: 70 }, (_, i) => item(i + 2))
  ])
  database.db.prepare('UPDATE journal_rows SET ts = ts + 500 WHERE seq > 1').run()
  const original = liveTestJournalRows(database.db, sessionId)
  const initial = restoreJournal(database.db, sessionId)!.state
  const interrupted = new JournalProjectionCatchUp(database, sessionId, epoch)
  expect(await interrupted.load(unpacedCatchUp)).toBe('ready')
  expect(interrupted.page()).toBe('advanced')
  interrupted.close()
  expect(journalOutcomeSource(database.db, sessionId, epoch)).toBeNull()
  expect(liveTestJournalRows(database.db, sessionId)).toEqual(original)
  while (sweepJournalOutcomePage(database)) {
    /* Bounded cleanup pages. */
  }
  expect(database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n).toBe(0)
  const rig = projectionWriter(database, initial)
  rigs.push(rig)
  const conversion = new JournalProjectionCatchUp(database, sessionId, epoch)
  expect(await conversion.load(unpacedCatchUp)).toBe('ready')
  expect(conversion.page()).toBe('advanced')
  await rig.writer.enqueue((seq, ts) => ({ ...item(seq), ts }))
  expect(journalOutcomeSource(database.db, sessionId, epoch)).toBeNull()
  const fullFold = restoreJournal(database.db, sessionId)!.state
  await finishCatchUp(conversion)
  expectProjectionMatches(database, fullFold)
  expect(encodeJournalState(fullFold)).toEqual(encodeJournalState(rig.state()))
  expect(database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n).toBeLessThan(
    40
  )
  // Conversion retains the complete original input history; only the founding version changes.
  expect(liveTestJournalRows(database.db, sessionId)).toHaveLength(original.length + 1)

  const cancelledEpoch = 'interrupted-epoch'
  database.transaction((db) => {
    publishTestJournalEpoch(db, sessionId, cancelledEpoch)
    insertTestJournalRow(db, sessionId, { ...projectionEpochRow, epoch: cancelledEpoch })
    insertTestJournalRow(db, sessionId, { ...item(2), epoch: cancelledEpoch })
  })
  const repairing = new JournalProjectionCatchUp(database, sessionId, cancelledEpoch)
  expect(await repairing.load(unpacedCatchUp)).toBe('ready')
  repairing.page()
  let published = false
  publishNewEpoch({
    database,
    identity: {
      sessionId,
      workspaceId: 'ws',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    epoch: 'replacement',
    reason: 'handle_forked',
    fence: 2,
    now: 20_000,
    queue: {
      cards: [],
      receipt: {
        write: () => {},
        committed: () => {
          // The receipt finalizes before the fallible publication step, as on main.
          expect(published).toBe(false)
        }
      }
    },
    onPublished: () => {
      published = true
    }
  })
  expect(repairing.page()).toBe('retired')
  expect(restoreJournal(database.db, sessionId)?.state.epoch).toBe('replacement')
  while (sweepJournalOutcomePage(database)) {
    /* Retired generations are paged too. */
  }
  expect(
    database.db
      .prepare(
        'SELECT COUNT(*) AS n FROM journal_outcomes WHERE generation NOT IN (SELECT generation FROM journal_outcome_epochs)'
      )
      .get()?.n
  ).toBe(0)
})

it('fences cached opens and every writer before mutation, while the old parser refuses the founding row', async () => {
  const state = seedOutcomeRows(database, [projectionEpochRow, item(2)])
  const anchor = liveTestJournalRows(database.db, sessionId)[0]
  expect(anchor && parseJournalRow(anchor.rowJson)).toEqual({ ok: false, unreadable: true })
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  database.db.prepare('UPDATE journal_outcome_epochs SET format = 99').run()
  expect(restoreJournal(database.db, sessionId)).toMatchObject({
    newer: { sequence: 1 },
    damage: null
  })
  const before = database.db
    .prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key')
    .all()
  await expect(rig.writer.enqueue((seq) => item(seq))).rejects.toMatchObject({
    code: 'journal_read_only'
  })
  expect(
    database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
  ).toEqual(before)
  expect(rig.state()).toBe(state)
  // Missing remains distinct from unsupported for ACP's resume and loss-warning decisions.
  expect(restoreJournal(database.db, 'missing-session')).toBeNull()
})
