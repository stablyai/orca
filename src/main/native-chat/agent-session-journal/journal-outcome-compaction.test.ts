import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { readAgentSessionHistory } from '../agent-session-wire/agent-session-history-page'
import { projectJournalBatch } from '../agent-session-wire/agent-session-journal-batch'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import {
  expectProjectionMatches,
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  seedProjectionRows
} from './journal-projection-test-support'
import type { JournalRow } from './journal-row-schema'

let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-outcome-compaction-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  await journals.closeAll()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

const item = (seq: number, itemId: string, revision: number): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId,
  revision,
  body: { kind: 'status', text: `${itemId} ${revision}` }
})
const records = () =>
  database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq, field, entry_key').all()
function compact(compaction = new JournalOutcomeCompaction()): void {
  while (compaction.page(database)) {
    // Each call commits at most one bounded page.
  }
}

it('keeps a mixed prefix byte-identical, including masks and ordering across deletion and re-creation', async () => {
  const state = seedProjectionRows(database, [projectionEpochRow, item(2, 'x', 1), item(3, 'y', 1)])
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  const raw = () => database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
  const prefix = raw()
  for (let revision = 2; revision <= 40; revision++) {
    await rig.writer.enqueue((seq) => item(seq, 'x', revision))
  }
  await rig.writer.enqueue((seq) => ({ ...base(seq), kind: 'tombstone', itemId: 'y', revision: 2 }))
  await rig.writer.enqueue((seq) => ({
    ...base(seq),
    kind: 'lifecycle-batch',
    settlementId: 'reinsert',
    mutations: [
      { kind: 'tombstone', itemId: 'x', revision: 41 },
      { kind: 'item', itemId: 'z', revision: 1, body: { kind: 'status', text: 'z' } },
      { kind: 'item', itemId: 'x', revision: 42, body: { kind: 'status', text: 'x re-created' } }
    ]
  }))
  const before = records()
  const rows = raw()
  const facts = before.filter((row) => row.deleted === 1 || row.field === 'tombstones')
  expect(facts.some((row) => row.field === 'items' && row.entry_key === '"y"')).toBe(true)
  compact()
  expect(records().length).toBeLessThan(before.length)
  expect(records().filter((row) => row.deleted === 1 || row.field === 'tombstones')).toEqual(facts)
  expect(raw()).toEqual(rows)
  expect(raw().slice(0, prefix.length)).toEqual(prefix)
  for (const row of records()) {
    expect(before).toContainEqual(row)
  }
  expect([...rig.state().items.keys()]).toEqual(['z', 'x'])
  expectProjectionMatches(database, rig.state())
})

it('stops at an unknown record format and never deletes anything after it', () => {
  seedOutcomeRows(database, [
    projectionEpochRow,
    ...Array.from({ length: 100 }, (_, n) => item(n + 2, 'x', n + 1))
  ])
  // A mismatched summary also exercises the per-record fence rather than only the fast summary.
  database.db.prepare('UPDATE journal_outcomes SET format = 2 WHERE seq = 40').run()
  const before = records()
  compact()
  expect(records().length).toBeLessThan(before.length)
  expect(records().filter((row) => Number(row.seq) >= 40)).toEqual(
    before.filter((row) => Number(row.seq) >= 40)
  )
  database.db.prepare('UPDATE journal_outcome_epochs SET format = 2').run()
  const stopped = records()
  compact()
  expect(records()).toEqual(stopped)
})

it('preserves catch-up at every cursor and backward history pages after real cleanup', async () => {
  const rows: JournalRow[] = [projectionEpochRow]
  for (let revision = 1; revision <= 30; revision++) {
    for (const id of ['x', 'y', 'z']) {
      rows.push(item(rows.length + 1, id, revision))
    }
  }
  seedOutcomeRows(database, rows)
  const journal = await journals.open({
    identity: {
      sessionId,
      workspaceId: 'ws',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory: root
  })
  const catchUp = () =>
    Array.from({ length: rows.length }, (_, sequence) => {
      const result = journal.readSince({ epoch, sequence })
      if (!result.ok) {
        throw new Error('missing catch-up')
      }
      return projectJournalBatch({
        rows: result.rows,
        snapshot: journal.snapshot(),
        afterSequence: sequence
      })
    })
  const history = () => {
    const tail = readAgentSessionHistory(journal, { sessionId, direction: 'tail', limit: 2 })
    if (!tail.ok) {
      throw new Error('missing tail')
    }
    return [
      tail,
      readAgentSessionHistory(journal, {
        sessionId,
        direction: 'before',
        cursor: tail.page.window.nextCursor,
        limit: 2
      })
    ]
  }
  const expected = { catchUp: catchUp(), history: history() }
  const before = records().length
  compact()
  expect(records().length).toBeLessThan(before / 2)
  expect({ catchUp: catchUp(), history: history() }).toEqual(expected)
  // Three item keys keep just their first/latest records; metadata and insertion facts survive.
  expect(records().filter((row) => row.field === 'items')).toHaveLength(6)
})
