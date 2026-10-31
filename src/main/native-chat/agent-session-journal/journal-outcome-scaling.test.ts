import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem
} from '../../../shared/agent-session-journal-types'
import type { SqliteStatement } from '../../sqlite/sqlite-statement'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { readJournalRowsAfterCursor, restoreJournal } from './journal-open'
import { MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS, type JournalRow } from './journal-row-schema'
import { journalOutcomeSource } from './journal-outcome-format'
import { JournalOutcomeSweeper, sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { JOURNAL_NEWEST_OUTCOME_SQL } from './journal-outcome-table'
import { readJournalOutcomeGroups } from './journal-read-row'
import { applyJournalRow, type JournalReducerState } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import { encodeJournalState } from './journal-state-codec'
import type * as RowStorage from './journal-storage-row-schema'
import type * as Strict from './journal-storage-strict'
import type * as OutcomeFormat1 from './journal-outcome-format-1'
import type * as Transition from './journal-reducer-transition'
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

// Admission's own work: strict walks of input rows and of outcome records, counted at the calls,
// and every strict walk at all, counted at each strict schema storage builds.
const admission = vi.hoisted(() => ({ rows: 0, records: 0, walks: 0 }))
vi.mock('./journal-storage-strict', async (original) => {
  const actual = await original<typeof Strict>()
  // A schema storage cannot close further comes back as it is, so one instance can recur.
  const counted = new WeakSet<ReturnType<typeof actual.strictStorage>>()
  return {
    ...actual,
    strictStorage: (schema: Parameters<typeof actual.strictStorage>[0]) => {
      const strict = actual.strictStorage(schema)
      if (counted.has(strict)) {
        return strict
      }
      counted.add(strict)
      const walk = strict.safeParse.bind(strict)
      Object.defineProperty(strict, 'safeParse', {
        value: (...input: Parameters<typeof walk>) => {
          admission.walks += 1
          return walk(...input)
        }
      })
      return strict
    }
  }
})
vi.mock('./journal-storage-row-schema', async (original) => {
  const actual = await original<typeof RowStorage>()
  return {
    ...actual,
    journalRowDeclaresMore: (row: unknown) => {
      admission.rows += 1
      return actual.journalRowDeclaresMore(row)
    }
  }
})
vi.mock('./journal-outcome-format-1', async (original) => {
  const actual = await original<typeof OutcomeFormat1>()
  return {
    ...actual,
    admitOutcomeFormat1: (value: Parameters<typeof actual.admitOutcomeFormat1>[0]) => {
      admission.records += 1
      return actual.admitOutcomeFormat1(value)
    }
  }
})
// Every draft transition a write or a replacement folds through, to count the nodes it reaches.
const transitions = vi.hoisted(() => {
  const opened: { tracked: () => number }[] = []
  return opened
})
vi.mock('./journal-reducer-transition', async (original) => {
  const actual = await original<typeof Transition>()
  return {
    ...actual,
    isolateJournalTransition: (...input: Parameters<typeof actual.isolateJournalTransition>) => {
      const transition = actual.isolateJournalTransition(...input)
      transitions.push(transition)
      return transition
    }
  }
})
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
  journal_outcomes: 'value_json'
} as const
const TRANSACTION = /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/

let root: string
const rigs: ReturnType<typeof projectionWriter>[] = []
const journals = createTrackedJournalOpener()
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-scaling-'))
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  await journals.closeAll()
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
  // The item's record alone: the sequence is the epoch's coverage, never a record.
  expect(small.streamed.writes).toStrictEqual([['journal_outcomes INSERT', 1]])
})

/** One settlement row creating `size` status items. */
const batchOf =
  (size: number) =>
  (seq: number, ts: number): JournalRow => ({
    ...base(seq),
    ts,
    kind: 'lifecycle-batch',
    settlementId: `batch-${size}`,
    mutations: Array.from({ length: size }, (_, index) => ({
      kind: 'item' as const,
      itemId: `batch-${index}`,
      revision: 1,
      body: { kind: 'status' as const, text: `Batch ${index}` }
    }))
  })

it('encodes a settlement batch with the same work per mutation up to the mutation cap', async () => {
  const measure = async (size: number) => {
    const { database, rig } = outcomeChat(N, `batch-${size}`)
    const watched = watch(database)
    const stringify = vi.spyOn(JSON, 'stringify')
    await rig.writer.enqueue(batchOf(size))
    const calls = stringify.mock.calls.length
    const work = watched.take()
    watched.stop()
    expect(rig.state().items.has(`batch-${size - 1}`)).toBe(true)
    return { calls, statements: work.statements.length }
  }
  // Schemas compile on their first parse; that one-time work is not the batch's.
  await measure(10)
  const few = await measure(20)
  const more = await measure(110)
  const most = await measure(MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS)
  // Linear in the batch: each further 90 mutations add the same work.
  expect(most.calls - more.calls).toBe(more.calls - few.calls)
  expect(most.statements).toBe(few.statements)
})

/** A tool call whose structured input holds `size` nested objects, as a large multi-edit does. */
const toolCall = (size: number) => ({
  kind: 'tool-call' as const,
  name: 'edit',
  input: {
    edits: Array.from({ length: size }, (_, index) => ({ path: `file-${index}`, at: { index } }))
  },
  state: 'running' as const
})

it("encodes a structured tool call's revisions without reading its input through the draft, at N and 10N nested objects", async () => {
  const measure = async (size: number) => {
    const { rig } = outcomeChat(N, `tool-${size}`)
    // The draft's copy-on-write proxies read through Reflect.get; plain reads never call it.
    const reads = vi.spyOn(Reflect, 'get')
    await rig.writer.enqueue(revision('tool', toolCall(size), 1))
    const first = reads.mock.calls.length
    reads.mockClear()
    await rig.writer.enqueue(revision('tool', toolCall(size), 2))
    const next = reads.mock.calls.length
    reads.mockRestore()
    expect(rig.state().items.get('tool')?.body).toEqual(toolCall(size))
    return { first, next }
  }
  expect(await measure(10 * N)).toStrictEqual(await measure(N))
})

/** A chat this build wrote, holding `size` live items and `size` waiting queue cards. */
async function liveChat(size: number, label: string) {
  const stateDirectory = join(root, label)
  const journal = await journals.open({
    identity: {
      sessionId,
      workspaceId: 'ws-1',
      hostId: 'host-1',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread-1')
    },
    stateDirectory,
    // A fixed clock: a timestamp that moves mid-chat would change which rows touch the activity time.
    now: () => 10_000
  })
  const kept = Array.from({ length: size }, (_, ordinal) => ({
    identity: { provider: 'codex' as const, threadId: 'thread-1', turnId: 'turn-1', ordinal },
    body: { kind: 'status' as const, text: `Status ${ordinal}` },
    ownerFence: 1
  }))
  for (const { identity, body } of kept) {
    await journal.appendItem(identity, body, { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    await journal.queuedMessages.insert({
      messageId: `card-${identity.ordinal}`,
      body: message(`card ${identity.ordinal}`)
    })
  }
  return { journal, kept, database: openTestJournalHostDatabase(stateDirectory) }
}

// Rewind, replacement and rollover restate the live chat in one transaction, as main does: the
// epoch's rows are built by one fold and its records by a second through the draft. Both stay
// linear: the statements are fixed, and rows read, rows written and draft nodes grow by the same
// amount for each restated item and card.
it.each(['rewind', 'replacement', 'rollover'] as const)(
  'publishes a %s of a chat with the same work per restated item at N, 2N and 11N',
  async (path) => {
    const measure = async (size: number) => {
      const { journal, kept, database } = await liveChat(size, `${path}-${size}`)
      const watched = watch(database)
      transitions.length = 0
      await (path === 'rollover'
        ? journal.rollEpoch('unreconcilable_prefix', 1)
        : journal.replaceEpochItems(path === 'rewind' ? 'handle_forked' : 'legacy_import', 1, kept))
      const work = watched.take()
      watched.stop()
      expect(journal.snapshot().items).toHaveLength(path === 'rollover' ? 0 : size)
      expect(journal.queuedMessages.list()).toHaveLength(size)
      const counts = new Map<string, number>([
        ...Object.entries(work.read).map(([table, rows]): [string, number] => [
          `read ${table}`,
          rows
        ]),
        ...work.writes.map(([target, rows]): [string, number] => [`${target}`, Number(rows)]),
        ['draft nodes', transitions.reduce((sum, transition) => sum + transition.tracked(), 0)]
      ])
      return { statements: work.statements, counts }
    }
    // A chat's first item and card start collections an empty chat lacks, so the line is taken
    // between non-empty chats: 10N more restated items cost ten times what N more do.
    const base = await measure(N)
    const small = await measure(2 * N)
    const large = await measure(11 * N)
    expect(large.statements).toStrictEqual(small.statements)
    expect([...large.counts.keys()]).toStrictEqual([...small.counts.keys()])
    for (const [counted, value] of large.counts) {
      const from = base.counts.get(counted) ?? 0
      expect({ counted, grown: value - from }).toStrictEqual({
        counted,
        grown: 10 * ((small.counts.get(counted) ?? 0) - from)
      })
    }
    expect(large.counts.get('draft nodes')).toBeGreaterThan(small.counts.get('draft nodes') ?? 0)
  }
)

/** Distinct keys the chat's records hold, live, deleted and scalar alike. */
function outcomeKeys(database: JournalHostDatabase): number {
  return Number(
    database.db
      .prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT field, entry_key FROM journal_outcomes)')
      .get()?.n
  )
}

it("opens a new chat reading each key's newest record once, the same with N and 10N superseded revisions", async () => {
  const measure = async (revisions: number) => {
    const { database, rig } = outcomeChat(N, `open-${revisions}`)
    for (let index = 1; index <= revisions; index++) {
      await rig.writer.enqueue(revision('answer', message(`answer ${index}`, 'assistant'), index))
    }
    const records = database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n
    const watched = watch(database)
    const loaded = restoreJournal(database.db, sessionId)
    const work = watched.take()
    watched.stop()
    expect(loaded && encodeJournalState(loaded.state)).toEqual(encodeJournalState(rig.state()))
    return { database, work, records: Number(records), keys: outcomeKeys(database) }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  // Anti-vacuous: the larger chat holds 9N more superseded revisions of one key.
  expect(large.records - small.records).toBe(9 * N)
  expect(large.keys).toBe(small.keys)
  expectSameWork(small.work, large.work)
  // One record per key; of the chat's rows only the marker, which its outcome summary must agree with.
  expect(small.work.read).toStrictEqual({
    journal_outcome_epochs: 1,
    journal_outcomes: small.keys,
    journal_rows: 1,
    journal_sessions: 2
  })
  // Each read is one seek down the key index from the last key: no scan, no sort, no revision walk.
  const plan = small.database.db
    .prepare(`EXPLAIN QUERY PLAN ${JOURNAL_NEWEST_OUTCOME_SQL}`)
    .all(1, '', '', 1)
    .map((row) => String(row.detail))
  expect(plan).toEqual([
    'SEARCH journal_outcomes USING INDEX journal_outcome_keys (generation=? AND (field,entry_key)>(?,?))'
  ])
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

it('writes to an existing chat without reading its prefix, the same at N and 10N', async () => {
  const small = await prefixChat(N, 'prefix-append-small')
  const large = await prefixChat(10 * N, 'prefix-append-large')
  for (const key of ['first', 'streamed', 'accepted'] as const) {
    expectSameWork(small[key], large[key])
  }
  // The first write appends the marker, then the item's record and the two scalars it changed.
  expect(small.first.writes).toStrictEqual([
    ['journal_outcomes INSERT', 3],
    ['journal_rows INSERT', 1]
  ])
  expect(small.streamed.writes).toStrictEqual([['journal_outcomes INSERT', 1]])
  expect(large.rig.state().submissions.get('send')?.dispatchState).toBe('accepted')
})

it("opens an existing chat reading main's prefix rows and each tail key's newest record, at N and 10N", async () => {
  const measure = async (size: number) => {
    const { database, rig } = await prefixChat(size, `prefix-open-${size}`)
    // The tail's one streamed item takes `size` more revisions: superseded, never read.
    for (let index = 3; index < size + 3; index++) {
      await rig.writer.enqueue(revision('answer', message(`answer ${index}`, 'assistant'), index))
    }
    const watched = watch(database)
    const loaded = restoreJournal(database.db, sessionId)
    const work = watched.take()
    watched.stop()
    expect(loaded && encodeJournalState(loaded.state)).toEqual(encodeJournalState(rig.state()))
    return { work, prefix: historyOf(size).length, keys: outcomeKeys(database) }
  }
  const small = await measure(N)
  const large = await measure(10 * N)
  for (const { work, prefix, keys } of [small, large]) {
    // The prefix rows main folds, plus the marker: checked against the outcome summary, and met
    // again on the prefix's last page.
    expect(work.read.journal_rows).toBe(prefix + 2)
    expect(work.read.journal_outcomes).toBe(keys)
  }
  expect(large.keys).toBe(small.keys)
})

/** The text of each keyed record an open decodes: every key's newest live record. */
function newestEntries(database: JournalHostDatabase) {
  const rows = database.db
    .prepare(
      `SELECT value_json FROM journal_outcomes o WHERE field <> '$' AND deleted = 0 AND seq =
        (SELECT MAX(seq) FROM journal_outcomes WHERE generation = o.generation AND field = o.field
        AND entry_key = o.entry_key)`
    )
    .all()
  return { texts: new Set(rows.map((row) => String(row.value_json))), records: rows.length }
}

// Admission is linear in what is read, with a constant of one: one strict walk per input row read
// (main parses each row once; this adds the walk), one per outcome record read or written. Decoding
// takes each record as admission parsed it: no record is parsed or walked twice.
it('admits each row and record an existing chat reads or writes once, at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database, rig } = await prefixChat(size, `admission-${size}`)
    const entries = newestEntries(database)
    const watched = watch(database)
    admission.rows = 0
    admission.records = 0
    admission.walks = 0
    const parses = vi.spyOn(JSON, 'parse')
    restoreJournal(database.db, sessionId)
    const parsed = parses.mock.calls.filter(([text]) => entries.texts.has(text)).length
    parses.mockRestore()
    const open = { ...admission, parsed, entries: entries.records, read: watched.take().read }
    admission.rows = 0
    const page = readJournalRowsAfterCursor(database.db, sessionId, epoch, 0, 100)
    const paged = { walks: admission.rows, rows: page.filter((row) => row.kind !== 'outcome') }
    admission.rows = 0
    admission.records = 0
    admission.walks = 0
    await rig.writer.enqueue(revision('answer', message('z'.repeat(4_096), 'assistant'), 3))
    const written = { ...admission, writes: watched.take().writes }
    watched.stop()
    return { open, paged, written, prefix: historyOf(size).length, keys: outcomeKeys(database) }
  }
  for (const { open, paged, written, prefix, keys } of [await measure(N), await measure(10 * N)]) {
    // The marker is read twice (source check, last prefix page) and walked never.
    expect(open.read.journal_rows).toBe(prefix + 2)
    expect(open.rows).toBe(prefix)
    expect(open.records).toBe(keys)
    expect(open.walks).toBe(open.rows + open.records)
    expect(open.entries).toBeGreaterThan(0)
    expect(open.parsed).toBe(open.entries)
    expect(paged.rows).toHaveLength(100)
    expect(paged.walks).toBe(100)
    // The written row's read-back, and each record the write inserts.
    expect(written.rows).toBe(1)
    expect(written.writes).toStrictEqual([['journal_outcomes INSERT', written.records]])
    expect(written.walks).toBe(written.rows + written.records)
  }
})

it('runs a sweep pass with nothing to retire without reading history at N and 10N', async () => {
  const measure = async (size: number) => {
    const { database } = outcomeChat(size, `idle-${size}`)
    const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: async () => {} })
    const watched = watch(database)
    await sweeper.pass()
    sweeper.stop()
    const work = watched.take()
    watched.stop()
    return work
  }
  const small = await measure(N)
  for (const table of ['journal_rows', 'journal_outcomes']) {
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

it('sweeps a retired generation numbered after N and 10N live chats without rescanning them per page', () => {
  const measure = (chats: number) => {
    const database = databaseFor(`sweep-chats-${chats}`)
    database.transaction((db) => {
      const generation = db.prepare(
        'INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)'
      )
      const live = db.prepare('INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, 1, 1, 0)')
      for (let index = 0; index < chats; index++) {
        const id = Number(generation.run(`chat-${index}`, epoch).lastInsertRowid)
        live.run(`chat-${index}`, epoch, id)
      }
      const retired = Number(generation.run('gone', 'gone-epoch').lastInsertRowid)
      const insert = db.prepare(`INSERT INTO journal_outcomes
        (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
        VALUES (?, 1, 'aliases', ?, 1, 's0000000000000001:0000000000000000', ?, 0)`)
      for (let index = 0; index < 100; index++) {
        insert.run(retired, JSON.stringify(`k${index}`), JSON.stringify([`k${index}`, 'v']))
      }
    })
    // Each page's candidate scan walks the generations above its position in order, so the live
    // ones it passes are those numbered above that position.
    const positions: number[] = []
    const prepare = database.db.prepare.bind(database.db)
    vi.spyOn(database.db, 'prepare').mockImplementation((sql: string) => {
      const statement = prepare(sql)
      if (!sql.includes('LEFT JOIN journal_outcome_epochs')) {
        return statement
      }
      const recorded: SqliteStatement = {
        all: (...parameters) => {
          positions.push(Number(parameters[0]))
          return statement.all(...parameters)
        },
        get: (...parameters) => statement.get(...parameters),
        run: (...parameters) => statement.run(...parameters),
        iterate: (...parameters) => statement.iterate(...parameters),
        setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
      }
      return recorded
    })
    while (sweepJournalOutcomePage(database)) {
      // One bounded page per call.
    }
    vi.mocked(database.db.prepare).mockRestore()
    const passed = database.db.prepare(
      'SELECT COUNT(*) AS n FROM journal_outcome_epochs WHERE generation > ?'
    )
    return positions.map((position) => Number(passed.get(position)?.n))
  }
  const small = measure(N)
  const large = measure(10 * N)
  // Four record pages and the page that drops the generation row; only a pass's first page walks
  // the live chats, as an idle pass does.
  expect(small).toEqual([N, 0, 0, 0, 0])
  expect(large).toEqual([10 * N, 0, 0, 0, 0])
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
