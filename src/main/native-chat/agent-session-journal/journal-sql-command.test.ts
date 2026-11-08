import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import {
  advanceJournalOutcomeSource,
  ensureJournalOutcomeTables
} from './outcomes/journal-outcome-format'
import {
  persistJournalOutcomeRows,
  persistJournalOutcomeTransition
} from './outcomes/journal-outcome-table'
import { createJournalReducerState } from './projection/journal-reducer'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import { planJournalWriterRows } from './journal-writer-plan'
import type {
  JournalWriterCommand,
  JournalWriterCoreOperation,
  JournalWriterOperation
} from './journal-writer-command'
import { journalInputOrder } from './input-order/journal-input-order'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { CommandReceipt } from './writing/command-receipt-schema'
import { readCommandReceipt } from './writing/command-receipt-table'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalWriterStep } from './writing/journal-writer-step'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})
const target = { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' }
const identity = { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 } as const
const itemId = agentJournalItemKey(identity)
const item = (text: string, fence = 1): JournalWriterCoreOperation => ({
  kind: 'item',
  identity,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] },
  options: { fence, turnScope: { kind: 'thread' } }
})
const command = (operation: JournalWriterOperation): JournalWriterCommand => ({ target, operation })

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  const { source, initial } = seedJournalSqlCommands(db)
  return {
    db,
    source,
    initial,
    engine: new JournalSqlCommand(db, '/unused'),
    batch: new JournalSqlBatch(db)
  }
}

it('commits a step prefix without leaking the rolled-back session or admitting its suffix', async () => {
  const { db, engine, batch } = fixture()
  db.exec(`CREATE TEMP TRIGGER refuse_step BEFORE INSERT ON journal_proj_items
    WHEN NEW.entry_key='"orca:refused"' BEGIN SELECT RAISE(ABORT, 'step refused'); END`)
  const step = (clientMessageId: string): JournalWriterStep => ({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId },
    body: { kind: 'status', text: clientMessageId },
    options: { fence: 1, turnScope: { kind: 'thread' } },
    reservedBytes: 1024
  })
  const answer = (
    await batch.run(
      [
        {
          command: command({
            kind: 'steps',
            steps: [step('first'), step('refused'), step('suffix')]
          }),
          normal: false
        }
      ],
      (entry) => engine.apply(entry, 100)
    )
  ).outcomes[0]!
  expect(answer).toMatchObject({
    committed: true,
    value: {
      cursor: { epoch: 'epoch', sequence: 2 },
      items: [{ itemId: 'orca:first', revision: 1, deleted: false }],
      value: {
        outcomes: [{ kind: 'committed', wrote: true }],
        failure: { message: 'step refused' }
      }
    }
  })
  if (!answer.committed) {
    throw new Error('prefix must commit')
  }
  expect(
    answer.value.keys.some((entry) => entry.key === 'orca:refused' || entry.key === 'orca:suffix')
  ).toBe(false)
  expect(
    db
      .prepare('SELECT entry_key FROM journal_proj_items ORDER BY ordinal')
      .all()
      .map((row) => JSON.parse(String(row.entry_key)))
  ).toContain('orca:first')
  expect(
    db
      .prepare('SELECT 1 FROM journal_proj_items WHERE entry_key IN (?,?)')
      .get('"orca:refused"', '"orca:suffix"')
  ).toBeUndefined()
})

it('assigns revisions after preceding successes and rolls back failed command projections and receipts', async () => {
  const { db, engine, batch, initial, source } = fixture()
  // A logical context boundary retains the physical epoch for ownership and log lookup.
  persistJournalOutcomeTransition(
    db,
    new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch').transition(),
    source,
    [{ ...initial, seq: 2 }],
    100,
    false,
    (state) => journalInputOrder(state).cards.ensure(state)
  )
  advanceJournalOutcomeSource(db, 'session', 'epoch', 2)
  db.prepare('UPDATE journal_proj_meta SET through_seq=2').run()
  const contextEpoch = 'context-v1:2cb86f27aabffce457946e9c46bd5d771895f95d6379dee0866d667e0ecb7adc'
  db.prepare('INSERT INTO agent_session_records VALUES (?, ?)').run('session', '{}')
  const receipt: CommandReceipt = {
    operationId: 'send',
    sessionId: 'session',
    callerKey: 'caller',
    method: 'agentSession.send',
    fingerprint: 'fingerprint',
    acceptedAt: 100,
    status: 'accepted',
    result: { kind: 'journal-row', epoch: 'unassigned', sequence: 1 }
  }
  const accepted: JournalWriterCommand = {
    ...command(item('first')),
    effects: [
      {
        kind: 'receipt',
        scope: { kind: 'global' },
        receipt,
        row: { at: 'last', answer: 'journal-row' }
      }
    ]
  }
  const duplicate: JournalWriterCommand = {
    ...command(item('must roll back')),
    effects: [
      {
        kind: 'receipt',
        scope: { kind: 'global' },
        receipt,
        row: { at: 'last', answer: 'journal-row' }
      }
    ]
  }
  const results = await batch.run(
    [accepted, duplicate, command(item('second')), command(item('stale', 0))].map((entry) => ({
      command: entry,
      normal: engine.streamed(entry)
    })),
    (entry) => engine.apply(entry, 100)
  )
  expect(results.outcomes.map((result) => result.committed)).toEqual([true, false, true, false])
  const committed = results.outcomes.flatMap((result) => (result.committed ? [result.value] : []))
  expect(committed.map((result) => result.cursor)).toEqual([
    { epoch: contextEpoch, sequence: 3 },
    { epoch: contextEpoch, sequence: 4 }
  ])
  expect(committed.map((result) => result.items)).toEqual([
    [{ itemId, deleted: false, revision: 1, sequence: 3, sequenceIndex: 0 }],
    [{ itemId, deleted: false, revision: 2, sequence: 3, sequenceIndex: 0 }]
  ])
  const loaded = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch')
  expect(loaded.state.items.get(itemId)?.body).toEqual({
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'second' }]
  })
  expect(db.prepare('SELECT through_seq FROM journal_proj_meta').get()?.through_seq).toBe(4)
  expect(db.prepare('SELECT MAX(seq) AS seq FROM journal_outcomes').get()?.seq).toBe(4)
  expect(readCommandReceipt(db, { kind: 'global' }, 'send')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', epoch: contextEpoch, sequence: 3 } }
  })
})

it('keeps exact saved records across command shells and publishes metadata without item bodies', async () => {
  const { db, source, initial, engine, batch } = fixture()
  const oracle = new Database(':memory:')
  databases.push(oracle)
  ensureJournalOutcomeTables(oracle)
  let memory = persistJournalOutcomeRows(
    oracle,
    createJournalReducerState('session', 'epoch'),
    source,
    [initial],
    100,
    true,
    (state) => journalInputOrder(state).cards.ensure(state)
  ).adopt()
  const operations: JournalWriterCoreOperation[] = [
    item('one'),
    item('two'),
    {
      kind: 'lifecycle',
      input: {
        settlementId: 'settled',
        fence: 1,
        mutations: [
          { kind: 'tombstone', identity },
          {
            kind: 'item',
            identity,
            turnScope: { kind: 'thread' },
            body: {
              kind: 'message',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'recreated' }]
            }
          }
        ]
      }
    },
    { kind: 'stop', fence: 1, event: { reason: 'user-stop' } },
    { kind: 'queue-resume', fence: 1 },
    { kind: 'queue-reopen', fence: 1, since: 2 },
    { kind: 'tombstone', identity, fence: 1 }
  ]
  for (const operation of operations) {
    const rows = planJournalWriterRows(memory, operation).map((build, index) =>
      build(memory.lastSequence + index + 1, 100)
    )
    memory = persistJournalOutcomeRows(oracle, memory, source, rows, 100, false, (state) =>
      journalInputOrder(state).cards.ensure(state)
    ).adopt()
    const result = (
      await batch.run([{ command: command(operation), normal: false }], (entry) =>
        engine.apply(entry, 100)
      )
    ).outcomes[0]!
    expect(result.committed).toBe(true)
  }
  const records = (connection: Database.Database) =>
    connection
      .prepare(`SELECT seq, field, entry_key,
    format, ordinal, value_json, deleted FROM journal_outcomes ORDER BY seq, field, entry_key`)
      .all()
  expect(records(db)).toEqual(records(oracle))
  const final = (
    await batch.run([{ command: command(item('after deletion')), normal: false }], (entry) =>
      engine.apply(entry, 100)
    )
  ).outcomes[0]!
  expect(final).toMatchObject({
    committed: true,
    value: { items: [{ itemId, revision: 6, deleted: false }] }
  })
  expect(JSON.stringify(final)).not.toContain('after deletion')
})

it('chooses NORMAL only for proven text revisions and retains FULL for settlements and effects', async () => {
  const { db, engine, batch } = fixture()
  expect(engine.streamed(command(item('first')))).toBe(false)
  await batch.run([{ command: command(item('first')), normal: false }], (entry) =>
    engine.apply(entry, 100)
  )
  const revision = command(item('next'))
  db.pragma('query_only = ON')
  try {
    expect(engine.streamed(revision)).toBe(true)
  } finally {
    db.pragma('query_only = OFF')
  }
  expect(
    engine.streamed({
      ...revision,
      effects: [{ kind: 'queue-delete', sessionId: 'session', messageIds: [] }]
    })
  ).toBe(false)
  expect(engine.streamed(command({ kind: 'queue-resume', fence: 1 }))).toBe(false)
  let synchronous = -1
  await batch.run([{ command: revision, normal: engine.streamed(revision) }], (entry) => {
    synchronous = Number(db.pragma('synchronous', { simple: true }))
    return engine.apply(entry, 100)
  })
  expect(synchronous).toBe(1)
  expect(Number(db.pragma('synchronous', { simple: true }))).toBe(2)
})

it('refuses stale ownership, changed epochs and log coverage even for an empty plan', async () => {
  const { db, engine, batch } = fixture()
  const noOp = command({
    kind: 'dispatch',
    input: { clientMessageId: 'missing', state: 'unknown', fence: 1 },
    onlyIfUnsettled: true
  })
  const run = async (entry = noOp) =>
    (await batch.run([{ command: entry, normal: false }], (value) => engine.apply(value, 100)))
      .outcomes[0]!
  expect(
    await run({
      ...noOp,
      effects: [
        {
          kind: 'store',
          insertOperationsIfAbsent: false,
          writes: {
            records: { upsert: [], remove: [] },
            operations: { upsert: [['ignored', '{}']], remove: [] },
            retiredClaimKeys: null,
            sessionTabs: null
          }
        }
      ]
    })
  ).toMatchObject({ committed: true, value: { inputChanged: false, effects: [] } })
  expect(db.prepare('SELECT 1 FROM agent_session_operations').get()).toBeUndefined()
  expect((await run({ ...noOp, target: { ...target, ownerToken: 'old' } })).committed).toBe(false)
  db.prepare('UPDATE journal_sessions SET epoch=?').run('another-epoch')
  expect((await run()).committed).toBe(false)
  db.prepare('UPDATE journal_sessions SET epoch=?').run('epoch')
  db.prepare('UPDATE journal_outcome_epochs SET through_seq=2').run()
  expect((await run()).committed).toBe(false)
  expect(db.prepare('SELECT through_seq FROM journal_proj_meta').get()?.through_seq).toBe(1)
})

it('replaces the epoch inside one writer command, moving the logical cursor epoch', async () => {
  const { engine, batch } = fixture()
  const run = async (entry: JournalWriterCommand) =>
    (await batch.run([{ command: entry, normal: false }], (value) => engine.apply(value, 100)))
      .outcomes[0]!
  const before = await run(command(item('before')))
  const replaced = await run(
    command({
      kind: 'epoch-replace',
      reason: 'handle_forked',
      fence: 1,
      items: [],
      providerHandle: agentSessionJournalProviderHandle({ agent: 'codex', providerHandle: null })
    })
  )
  if (!before.committed || !replaced.committed) {
    throw new Error('both commands commit')
  }
  expect(replaced.value.cursor.epoch).not.toBe(before.value.cursor.epoch)
  expect(replaced.value.cursor.sequence).toBeGreaterThan(before.value.cursor.sequence)
})
