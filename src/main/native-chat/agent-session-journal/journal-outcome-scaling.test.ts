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
  insertTestJournalRow,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { restoreJournal } from './journal-open'
import type { JournalRow } from './journal-row-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { JournalOutcomeConversion } from './journal-outcome-conversion'
import { sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { JOURNAL_OUTCOME_PAGE_BYTES, JOURNAL_OUTCOME_PAGE_ROWS } from './journal-outcome-table'
import { readJournalOutcomeGroups } from './journal-read-row'
import { sweepJournalSavedState } from './journal-saved-state'
import { JournalMaintenanceRunner } from './journal-state-backfill'
import {
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedOutcomeRows,
  seedProjectionRows,
  unpacedCatchUp
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
function historyOf(size: number): JournalRow[] {
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

it('opens a converted chat from its cache without reading an outcome or input row at N and 10N', () => {
  for (const size of [N, 10 * N]) {
    const { database, rig } = outcomeChat(size, `open-${size}`)
    const watched = watch(database)
    expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(rig.state().lastSequence)
    expect(watched.rowsRead('journal_outcomes')).toBe(0)
    // Only the founding row, which fences the outcome format.
    expect(watched.rowsRead('journal_rows')).toBe(1)
    watched.stop()
  }
})

it('converts one page and publishes with the same bounded work at N and 10N', async () => {
  const measure = async (size: number) => {
    const database = databaseFor(`convert-${size}`)
    seedProjectionRows(database, historyOf(size))
    const conversion = new JournalOutcomeConversion(database, sessionId, epoch)
    const watched = watch(database)
    expect(conversion.page()).toBe('advanced')
    const page = watched.take()
    let step = conversion.page()
    for (; step === 'advanced'; step = conversion.page()) {
      /* The rest of the input. */
    }
    expect(step).toBe('verify')
    expect(await conversion.verify(unpacedCatchUp)).toBe(true)
    watched.take()
    expect(conversion.page()).toBe('current')
    const publication = watched.take()
    watched.stop()
    conversion.close()
    expect(journalOutcomeSource(database.db, sessionId, epoch)?.through).toBe(4 * size + 2)
    return { page, publication }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  // One page of input rows, and the founding row the outcome source reads.
  expect(small.page.read.journal_rows).toBe(JOURNAL_OUTCOME_PAGE_ROWS + 1)
  expect(small.page.bytes).toBeLessThan(JOURNAL_OUTCOME_PAGE_BYTES)
  expectSameWork(small.page, large.page)
  expectSameWork(small.publication, large.publication)
  // Publication reads the founding row twice, to fence and to rewrite it, and no history.
  expect(small.publication.read.journal_rows).toBe(2)
  expect(small.publication.read.journal_outcomes ?? 0).toBe(0)
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
    database.db.exec(`INSERT INTO journal_outcome_attempts (session_id, epoch)
      VALUES ('${sessionId}', '${epoch}')`)
    database.db.exec(`UPDATE journal_outcome_epochs SET generation =
      (SELECT MAX(generation) FROM journal_outcome_attempts)`)
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

it('verifies a conversion again reading only the outcomes written since its last verify at N and 10N', async () => {
  const measure = async (size: number) => {
    const database = databaseFor(`verify-${size}`)
    const rows = historyOf(size)
    seedProjectionRows(database, rows)
    const conversion = new JournalOutcomeConversion(database, sessionId, epoch)
    const until = (wanted: string) => {
      let step = conversion.page()
      for (; step === 'advanced'; step = conversion.page()) {
        /* The rest of the input. */
      }
      expect(step).toBe(wanted)
    }
    until('verify')
    expect(await conversion.verify(unpacedCatchUp)).toBe(true)
    database.transaction((db) => {
      for (let index = 1; index <= 3; index++) {
        insertTestJournalRow(
          db,
          sessionId,
          revision(
            'answer',
            message(`Answer ${index}`, 'assistant'),
            index
          )(rows.length + index, 100_000)
        )
      }
    })
    until('verify')
    const watched = watch(database)
    expect(await conversion.verify(unpacedCatchUp)).toBe(true)
    const work = watched.take()
    watched.stop()
    until('current')
    conversion.close()
    return work
  }
  const small = await measure(N)
  expect(small.read.journal_rows ?? 0).toBe(0)
  expectSameWork(small, await measure(10 * N))
})
