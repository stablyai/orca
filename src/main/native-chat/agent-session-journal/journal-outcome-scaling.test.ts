import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { SqliteStatement } from '../../sqlite/sqlite-statement'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { restoreJournal } from './journal-open'
import type { JournalRow } from './journal-row-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { JournalOutcomeRebuild } from './journal-outcome-rebuild'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { JOURNAL_OUTCOME_PAGE_BYTES, JOURNAL_OUTCOME_PAGE_ROWS } from './journal-outcome-table'
import { readJournalOutcomeGroups } from './journal-read-row'
import { applyJournalRow, type JournalReducerState } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import { clearJournalSavedState, sweepJournalSavedState } from './journal-saved-state'
import { JournalMaintenanceRunner } from './journal-state-backfill'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  seedProjectionRows
} from './journal-projection-test-support'

// N/10N contracts: each counts statements (prepare and exec), rows read and rows and bytes
// written, never time, and requires the same work for a chat ten times larger.
const N = 40
const providerHandle = { kind: 'codex', threadId: 'thread-1' } as const
const providerItemId = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})
const WRITTEN = {
  journal_rows: 'row_json',
  journal_outcomes: 'value_json',
  journal_items: 'item_json',
  journal_entries: 'entry_json',
  journal_state: 'state_json'
} as const
const TRANSACTION = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/

let root: string
const rigs: ReturnType<typeof projectionWriter>[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-scaling-'))
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

const message = (text: string, role: 'user' | 'assistant' = 'user'): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})
const send = (seq: number, clientMessageId: string, handoverRecorded?: true): JournalRow => ({
  ...base(seq),
  kind: 'submission',
  clientMessageId,
  body: message(clientMessageId),
  providerHandle,
  ...(handoverRecorded ? { handoverRecorded } : {}),
  payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, message(clientMessageId))
})
const revision =
  (itemId: string, body: Extract<JournalRow, { kind: 'item' }>['body'], value: number) =>
  (seq: number, ts: number): JournalRow => ({
    ...base(seq),
    ts,
    kind: 'item',
    itemId,
    revision: value,
    body
  })
const plan = (text: string) => ({
  kind: 'status' as const,
  text,
  providerFrame: {
    provider: 'codex',
    kind: 'notification:turn/plan/updated',
    payload: { head: text, byteLength: text.length, digest: 'd'.repeat(64), truncated: false }
  }
})

/** `size` accepted sends with their statuses and queue cards, then one handed-over send. */
function historyOf(size: number, everyCard = false): JournalRow[] {
  const rows: JournalRow[] = [projectionEpochRow]
  for (let index = 0; index < size; index++) {
    rows.push(send(rows.length + 1, `earlier-${index}`))
    rows.push({
      ...base(rows.length + 1),
      kind: 'dispatch',
      clientMessageId: `earlier-${index}`,
      state: 'accepted',
      providerItemId: `provider-${index}`,
      reason: null
    })
    rows.push({
      ...base(rows.length + 1),
      kind: 'item',
      itemId: `status-${index}`,
      revision: 1,
      body: { kind: 'status', text: `Status ${index}` }
    })
    rows.push({
      ...base(rows.length + 1),
      kind: 'queue',
      messageId: `waiting-${index}`,
      change: {
        op: 'queued',
        body: message(`waiting-${index}`),
        position: rows.length + 1,
        queuedAt: { epoch, sequence: rows.length }
      }
    })
    const outcomes = everyCard
      ? ([
          ['dispatched', { attempt: `attempt-${index}` }],
          ['returned', { returned: { reason: 'refused' } }]
        ] as const)
      : []
    for (const [state, outcome] of outcomes) {
      rows.push({
        ...base(rows.length + 1),
        kind: 'queue',
        messageId: `${state}-${index}`,
        change: {
          op: 'queued',
          body: message(`${state}-${index}`),
          position: rows.length + 1,
          queuedAt: { epoch, sequence: rows.length },
          ...outcome
        }
      })
    }
  }
  rows.push(send(rows.length + 1, 'send', true))
  return rows
}

function databaseFor(label: string): JournalHostDatabase {
  return openTestJournalHostDatabase(join(root, label))
}

function outcomeChat(size: number, label: string) {
  const database = databaseFor(label)
  const rig = projectionWriter(database, seedOutcomeRows(database, historyOf(size)))
  rigs.push(rig)
  return { database, rig }
}

/** Counts every statement, the rows each table returns, and the rows and bytes each table takes. */
function watch(database: JournalHostDatabase) {
  const triggers = Object.entries(WRITTEN).flatMap(([table, column]) =>
    ['INSERT', 'UPDATE', 'DELETE'].map((op) => {
      const bytes = op === 'DELETE' ? '0' : `length(CAST(NEW.${column} AS BLOB))`
      return `CREATE TEMP TRIGGER IF NOT EXISTS count_${table}_${op} AFTER ${op} ON ${table}
        BEGIN INSERT INTO scaling_writes VALUES ('${table} ${op}', ${bytes}); END;`
    })
  )
  database.db.exec(
    `CREATE TEMP TABLE IF NOT EXISTS scaling_writes (target TEXT, bytes INTEGER); ${triggers.join('\n')}`
  )
  database.db.exec('DELETE FROM scaling_writes')
  const statements: string[] = []
  const read = new Map<string, number>()
  const prepare = database.db.prepare.bind(database.db)
  const exec = database.db.exec.bind(database.db)
  vi.spyOn(database.db, 'exec').mockImplementation((sql: string) => {
    if (!TRANSACTION.test(sql.trim())) {
      statements.push(sql)
    }
    exec(sql)
  })
  vi.spyOn(database.db, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql)
    const statement = prepare(sql)
    const table = /\bFROM\s+(journal_\w+)/.exec(sql)?.[1] ?? 'other'
    const count = (rows: number): void => {
      read.set(table, (read.get(table) ?? 0) + rows)
    }
    const counted: SqliteStatement = {
      all: (...parameters) => {
        const rows = statement.all(...parameters)
        count(rows.length)
        return rows
      },
      get: (...parameters) => {
        const row = statement.get(...parameters)
        count(row ? 1 : 0)
        return row
      },
      run: (...parameters) => statement.run(...parameters),
      iterate: function* (...parameters) {
        for (const row of statement.iterate(...parameters)) {
          count(1)
          yield row
        }
      },
      setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
    }
    return counted
  })
  return {
    rowsRead: (table: string) => read.get(table) ?? 0,
    take: () => {
      const writes = prepare(
        'SELECT target, COUNT(*) AS n, SUM(bytes) AS bytes FROM scaling_writes GROUP BY target ORDER BY target'
      )
        .all()
        .map((row) => [String(row.target), Number(row.n), Number(row.bytes)] as const)
      exec('DELETE FROM scaling_writes')
      const work = {
        statements: [...statements],
        read: Object.fromEntries([...read].sort()),
        writes: writes.map(([target, n]) => [target, n]),
        bytes: writes.reduce((sum, [, , bytes]) => sum + bytes, 0)
      }
      statements.length = 0
      read.clear()
      return work
    },
    stop: () => vi.restoreAllMocks()
  }
}

function expectSameWork(
  small: ReturnType<ReturnType<typeof watch>['take']>,
  large: ReturnType<ReturnType<typeof watch>['take']>
): void {
  expect(large.statements).toStrictEqual(small.statements)
  expect(large.read).toStrictEqual(small.read)
  expect(large.writes).toStrictEqual(small.writes)
  // Only the digits of the larger chat's sequence numbers differ.
  expect(Math.abs(large.bytes - small.bytes)).toBeLessThanOrEqual(64)
}

it('appends a streamed revision, a Codex plan update and an acceptance with the same work at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database, rig } = outcomeChat(size, `append-${size}`)
    await rig.writer.enqueue(revision('answer', message('x'.repeat(4_096), 'assistant'), 1))
    await rig.writer.enqueue(revision('plan', plan('Plan 1'), 1))
    const watched = watch(database)
    await rig.writer.enqueue(revision('answer', message('y'.repeat(4_096), 'assistant'), 2))
    const streamed = watched.take()
    await rig.writer.enqueue(revision('plan', plan('Plan 2'), 2))
    const planned = watched.take()
    await rig.writer.enqueue(revision(providerItemId, message('send'), 1))
    const accepted = watched.take()
    watched.stop()
    expect(rig.state().submissions.get('send')?.dispatchState).toBe('accepted')
    return { streamed, planned, accepted }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  for (const key of ['streamed', 'planned', 'accepted'] as const) {
    expectSameWork(small[key], large[key])
  }
  // The item's outcome and the sequence scalar, the cache row and its stamp.
  expect(small.streamed.writes).toStrictEqual([
    ['journal_items UPDATE', 1],
    ['journal_outcomes INSERT', 2],
    ['journal_state UPDATE', 1]
  ])
})

it('opens a new chat from its cache without reading an outcome or input row at N and 10N', () => {
  for (const size of [N, 10 * N]) {
    const { database, rig } = outcomeChat(size, `open-${size}`)
    const watched = watch(database)
    expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(rig.state().lastSequence)
    expect(watched.rowsRead('journal_outcomes')).toBe(0)
    // Only the marker row, which the epoch's outcome summary must agree with.
    expect(watched.rowsRead('journal_rows')).toBe(1)
    watched.stop()
  }
})

/** An existing chat of `size` sends in its input rows, then three writes as outcome records. */
async function prefixChat(size: number, label: string) {
  const database = databaseFor(label)
  const rig = projectionWriter(database, seedProjectionRows(database, historyOf(size)))
  rigs.push(rig)
  const watched = watch(database)
  await rig.writer.enqueue(revision('answer', message('x'.repeat(4_096), 'assistant'), 1))
  const first = watched.take()
  await rig.writer.enqueue(revision('answer', message('y'.repeat(4_096), 'assistant'), 2))
  const streamed = watched.take()
  await rig.writer.enqueue(revision(providerItemId, message('send'), 1))
  const accepted = watched.take()
  watched.stop()
  return { database, rig, first, streamed, accepted }
}

it('writes to an existing chat without reading its prefix or keeping a cache, the same at N and 10N', async () => {
  const small = await prefixChat(N, 'prefix-append-small')
  const large = await prefixChat(10 * N, 'prefix-append-large')
  for (const key of ['first', 'streamed', 'accepted'] as const) {
    expectSameWork(small[key], large[key])
  }
  // The first write appends the marker, then the item's record and the three scalars it changed.
  expect(small.first.writes).toStrictEqual([
    ['journal_outcomes INSERT', 4],
    ['journal_rows INSERT', 1]
  ])
  expect(small.streamed.writes).toStrictEqual([['journal_outcomes INSERT', 2]])
  expect(large.rig.state().submissions.get('send')?.dispatchState).toBe('accepted')
})

it("opens an existing chat reading main's prefix rows and only its records, at N and 10N", async () => {
  const measure = async (size: number) => {
    const { database, rig } = await prefixChat(size, `prefix-open-${size}`)
    const watched = watch(database)
    const loaded = restoreJournal(database.db, sessionId)
    const work = watched.take()
    watched.stop()
    expect(loaded?.state.lastSequence).toBe(rig.state().lastSequence)
    return { work, prefix: historyOf(size).length }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  for (const { work, prefix } of [small, large]) {
    // The prefix rows main folds, plus the marker: checked against the outcome summary, and met
    // again on the prefix's last page.
    expect(work.read.journal_rows).toBe(prefix + 2)
  }
  expect(large.work.read.journal_outcomes).toBe(small.work.read.journal_outcomes)
})

it('rebuilds a cache one bounded page at a time with the same work at N and 10N', () => {
  const measure = (size: number) => {
    const { database } = outcomeChat(size, `rebuild-${size}`)
    database.transaction((db) => clearJournalSavedState(db, sessionId))
    const source = journalOutcomeSource(database.db, sessionId, epoch)
    if (!source) {
      throw new Error('missing outcomes')
    }
    const rebuild = new JournalOutcomeRebuild(database, sessionId, epoch, source)
    expect(rebuild.page()).toBe('advanced')
    const watched = watch(database)
    expect(rebuild.page()).toBe('advanced')
    const work = watched.take()
    watched.stop()
    rebuild.close()
    return work
  }
  const small = measure(N)
  expect(small.read.journal_outcomes).toBe(JOURNAL_OUTCOME_PAGE_ROWS)
  expect(small.bytes).toBeLessThan(JOURNAL_OUTCOME_PAGE_BYTES)
  expectSameWork(small, measure(10 * N))
})

it('runs a background pass with nothing to do without reading history at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database } = outcomeChat(size, `idle-${size}`)
    const runner = new JournalMaintenanceRunner({
      database: () => database,
      delay: async () => {}
    })
    const watched = watch(database)
    await runner.pass()
    runner.stop()
    const work = watched.take()
    watched.stop()
    return work
  }
  const small = await measure(N)
  for (const table of ['journal_rows', 'journal_outcomes', 'journal_items', 'journal_entries']) {
    expect(small.read[table] ?? 0).toBe(0)
  }
  expectSameWork(small, await measure(10 * N))
})

it('sweeps a retired generation one bounded page per transaction at N and 10N', () => {
  const measure = (size: number) => {
    const { database } = outcomeChat(size, `sweep-${size}`)
    // A replacement generation retires the published one.
    database.db.exec(`INSERT INTO journal_outcome_generations (session_id, epoch)
      VALUES ('${sessionId}', '${epoch}')`)
    database.db.exec(`UPDATE journal_outcome_epochs SET generation =
      (SELECT MAX(generation) FROM journal_outcome_generations)`)
    const watched = watch(database)
    expect(sweepJournalOutcomePage(database)).toBe(true)
    const work = watched.take()
    watched.stop()
    return work
  }
  const small = measure(N)
  expect(small.writes).toStrictEqual([['journal_outcomes DELETE', 32]])
  expectSameWork(small, measure(10 * N))
})

it('catches a wire client up from outcomes reading only the groups it asks for at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database, rig } = outcomeChat(size, `wire-${size}`)
    const after = rig.state().lastSequence
    for (let index = 0; index < 3; index++) {
      await rig.writer.enqueue(
        revision('answer', message(`Answer ${index}`, 'assistant'), index + 1)
      )
    }
    const source = journalOutcomeSource(database.db, sessionId, epoch)
    if (!source) {
      throw new Error('missing outcomes')
    }
    const watched = watch(database)
    expect(readJournalOutcomeGroups(database.db, epoch, source, after, 200)).toHaveLength(3)
    const work = watched.take()
    watched.stop()
    return work
  }
  expectSameWork(await measure(N), await measure(10 * N))
})

it('sweeps an orphaned cache from its per-chat row with indexed deletes at N and 10N', () => {
  const measure = (size: number) => {
    const { database } = outcomeChat(size, `orphan-${size}`)
    database.db.exec('DELETE FROM journal_sessions')
    const watched = watch(database)
    expect(sweepJournalSavedState(database)).toBe(true)
    const work = watched.take()
    watched.stop()
    const plans = work.statements.flatMap((sql) =>
      database.db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((row) => String(row.detail))
    )
    expect(plans.filter((detail) => /SCAN (journal_items|journal_entries)\b/.test(detail))).toEqual(
      []
    )
    return work
  }
  const small = measure(N)
  expect(small.writes).toStrictEqual([['journal_items DELETE', 32]])
  expectSameWork(small, measure(10 * N))
})

/** Reducer nodes the draft reaches to fold `row` onto `state`, without adopting it. */
const trackedNodes = (state: JournalReducerState, row: JournalRow) =>
  isolateJournalTransition(state, (draft) => applyJournalRow(draft, row, row.ts)).tracked()

it("folds a streamed revision and an acceptance through the draft with only main's scans growing at N and 10N", () => {
  const measure = (size: number) => {
    const database = databaseFor(`draft-${size}`)
    const state = seedOutcomeRows(database, historyOf(size, true))
    const next = state.lastSequence + 1
    const live = {
      items: state.items.size,
      submissions: state.submissions.size,
      cards: state.queue.cards.size,
      returned: [...state.queue.cards.values()].filter((card) => card.state === 'returned').length,
      streamed: trackedNodes(
        state,
        revision('answer', message('y'.repeat(4_096), 'assistant'), 2)(next, 10_000)
      ),
      accepted: trackedNodes(state, revision(providerItemId, message('send'), 1)(next, 10_000))
    }
    return live
  }
  const small = measure(N)
  const large = measure(10 * N)
  const grown = (key: keyof typeof small) => large[key] - small[key]
  // Main's reducer scans these on the same rows; the draft adds one node per value it reaches.
  // A streamed revision's only growing term is the queue card scan: each card, and each returned
  // card's body.
  const cardScan = grown('cards') + grown('returned')
  expect(cardScan).toBeGreaterThan(0)
  expect(grown('streamed')).toBe(cardScan)
  // An echo also reads every item with its body (context-clear and echo lookups) and every
  // submission to find its send.
  expect(grown('accepted')).toBe(2 * grown('items') + grown('submissions') + cardScan)
})
