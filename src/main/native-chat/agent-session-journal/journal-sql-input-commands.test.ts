import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import Database from '../../sqlite/sync-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import {
  createJournalStoreCollaborators,
  type JournalStoreCollaborators
} from './journal-store-collaborators'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalWriteQueue } from './journal-write-queue'
import { prepareJournalOutcomeWrite } from './journal-outcome-write'
import { persistJournalOutcomeRows } from './journal-outcome-table'
import { ensureJournalOutcomeTables, startJournalOutcomeLog } from './journal-outcome-format'
import { createJournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { journalContextCursor } from './journal-context-cursor'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { createJournalTablesSql } from './journal-database-schema'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import {
  JournalHostFactsNeededError,
  journalMailSenderKey,
  type JournalWriterHostFacts
} from './journal-writer-host-facts'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { journalSqlFailure, restoreJournalSqlFailure } from './journal-sql-failure'

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
}
const target = { sessionId: 'session', epoch: 'epoch', ownerToken: 'open-token' }
const NOW = 1_000
const text = (value: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: value }]
})

let roots: string[] = []
beforeEach(() => {
  roots = []
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  for (const root of roots) {
    await rm(root, { recursive: true, force: true })
  }
})

/** Today's collaborators over an in-memory fold of the same seeded rows (no actual open on either side). */
function memoryJournal(database: JournalHostDatabase) {
  const scratch = new Database(':memory:')
  scratch.exec(createJournalTablesSql())
  ensureJournalOutcomeTables(scratch)
  const source = startJournalOutcomeLog(scratch, 'session', 'epoch', 0, 100)
  let state = persistJournalOutcomeRows(
    scratch,
    createJournalReducerState('session', 'epoch'),
    source,
    [journalSqlLifecycleRows()[0]!],
    100,
    true,
    (next) => journalInputOrder(next).cards.ensure(next)
  ).adopt()
  scratch.close()
  const collaborators: JournalStoreCollaborators = createJournalStoreCollaborators({
    notifyCommitted: () => undefined,
    identity,
    now: () => NOW,
    mintEpoch: () => 'minted',
    serialize: (run) => queue.serialize(run),
    database: () => database,
    state: () => state,
    readOnly: () => false,
    cursor: () => journalContextCursor(state),
    adopt: (loaded) => {
      state = loaded.state
    },
    prepare: (db, rows, savedAt, finishFold) => {
      collaborators.queuedMessages.inputState()
      const transition = prepareJournalOutcomeWrite(db, state, rows, savedAt, finishFold)
      return () => {
        state = transition.adopt()
      }
    },
    commit: () => undefined,
    journal: () => ({
      reopenFloor: () => null,
      appendItem: (...args) => collaborators.itemAppender.append(...args)
    }),
    enqueue: (build, receipt) => collaborators.rowWriter.enqueue(build, receipt)
  })
  const queue = new JournalWriteQueue('session')
  return collaborators
}

async function sides() {
  const memoryRoot = await mkdtemp(join(tmpdir(), 'orca-sql-input-memory-'))
  const sqlRoot = await mkdtemp(join(tmpdir(), 'orca-sql-input-writer-'))
  roots.push(memoryRoot, sqlRoot)
  const memoryDatabase = openTestJournalHostDatabase(memoryRoot)
  seedJournalSqlCommands(memoryDatabase.db)
  const memory = memoryJournal(memoryDatabase)
  const sqlDatabase = openTestJournalHostDatabase(sqlRoot)
  seedJournalSqlCommands(sqlDatabase.db)
  const engine = new JournalSqlCommand(sqlDatabase.db, sqlRoot)
  const batch = new JournalSqlBatch(sqlDatabase.db)
  const run = async (
    operation: JournalWriterOperation,
    facts: Partial<JournalWriterHostFacts> = {}
  ) => {
    const command: JournalWriterCommand = {
      target,
      operation,
      facts: { identity, ...facts },
      savedAt: NOW
    }
    const [outcome] = (
      await batch.run([{ command, normal: false }], (entry) => engine.apply(entry, NOW))
    ).outcomes
    if (!outcome!.committed) {
      // Exactly what reaches the host through the worker port.
      throw restoreJournalSqlFailure(journalSqlFailure(outcome!.error))
    }
    return outcome!.value
  }
  return { memory, memoryDb: memoryDatabase.db, sqlDb: sqlDatabase.db, run }
}

const saved = (db: Database.Database) => ({
  rows: db.prepare('SELECT seq, row_json FROM journal_rows ORDER BY seq').all(),
  outcomes: db
    .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
      FROM journal_outcomes ORDER BY seq, field, entry_key`)
    .all()
})

async function both<T>(
  side: Awaited<ReturnType<typeof sides>>,
  memory: (journal: JournalStoreCollaborators) => Promise<T>,
  operation: JournalWriterOperation,
  facts?: Partial<JournalWriterHostFacts>
) {
  const expected = await memory(side.memory).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  const actual = await side.run(operation, facts).then(
    (commit) => ({ value: (commit as { value?: unknown }).value }),
    (error: unknown) => ({ error })
  )
  if ('error' in expected) {
    expect(actual).toMatchObject({ error: expect.any(Error) })
    expect((actual as { error: Error }).error.name).toBe((expected.error as Error).name)
  } else {
    expect(actual).toEqual(expected)
  }
  expect(saved(side.sqlDb)).toEqual(saved(side.memoryDb))
  return actual
}

it('runs queued-card commands with the host collaborators and saves identical records', async () => {
  const side = await sides()
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'a', body: text('a') }), {
    kind: 'queue-insert',
    input: { messageId: 'a', body: text('a') }
  })
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'b', body: text('b') }), {
    kind: 'queue-insert',
    input: { messageId: 'b', body: text('b') }
  })
  // A duplicate admission appends nothing and answers the existing card.
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'a', body: text('again') }), {
    kind: 'queue-insert',
    input: { messageId: 'a', body: text('again') }
  })
  const card = side.memory.queuedMessages.get('a')!
  const update = {
    messageId: 'a',
    expectedBodyFingerprint: card.fingerprint,
    text: 'a edited'
  }
  await both(side, (j) => j.queuedMessages.update(update), { kind: 'queue-update', input: update })
  // The same fingerprint is now stale on both sides.
  await both(side, (j) => j.queuedMessages.update(update), { kind: 'queue-update', input: update })
  const move = { messageId: 'b', beforeMessageId: 'a' } as const
  await both(side, (j) => j.queuedMessages.move(move), { kind: 'queue-move', input: move })
  await both(side, (j) => j.queuedMessages.hold({ messageIds: ['a'], reason: 'send_failed' }), {
    kind: 'queue-hold',
    messageIds: ['a'],
    reason: 'send_failed'
  })
  await both(side, (j) => j.queuedMessages.withdraw(['b', 'missing']), {
    kind: 'queue-withdraw',
    messageIds: ['b', 'missing']
  })
})

it('hands over a card and settles sends with the same validation and records', async () => {
  const side = await sides()
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'c', body: text('c') }), {
    kind: 'queue-insert',
    input: { messageId: 'c', body: text('c') }
  })
  const fingerprint = side.memory.queuedMessages.get('c')!.fingerprint
  const handover = {
    clientMessageId: 'send-c',
    payloadFingerprint: fingerprint,
    body: text('c'),
    fence: 1
  }
  const consume = { messageId: 'c', expect: 'waiting' as const }
  // A wrong expectation refuses on both sides with the same error identity.
  await both(side, (j) => j.submissionWriter.append(handover, { ...consume, expect: 'returned' }), {
    kind: 'submission',
    input: handover,
    consume: { ...consume, expect: 'returned' }
  })
  await both(side, (j) => j.submissionWriter.append(handover, consume), {
    kind: 'submission',
    input: handover,
    consume
  })
  const send = {
    clientMessageId: 'send-d',
    payloadFingerprint: 'fp-d',
    body: text('d'),
    fence: 1,
    origin: 'client' as const
  }
  await both(side, (j) => j.submissionWriter.append(send), { kind: 'submission', input: send })
  const pending = {
    clientMessageId: 'send-d',
    state: 'pending' as const,
    fence: 1,
    turnScope: { kind: 'thread' as const }
  }
  await both(side, (j) => j.submissionWriter.resolveDispatch(pending), {
    kind: 'dispatch',
    input: pending
  })
  const accepted = {
    clientMessageId: 'send-d',
    state: 'accepted' as const,
    fence: 1,
    providerIdentity: null
  }
  await both(side, (j) => j.submissionWriter.acceptLate(accepted), {
    kind: 'accept-late',
    input: accepted
  })
  // Settled: a second late acceptance appends nothing.
  await both(side, (j) => j.submissionWriter.acceptLate(accepted), {
    kind: 'accept-late',
    input: accepted
  })
})

it('asks the host for mail availability and handover answers instead of calling back', async () => {
  const side = await sides()
  const from: AgentMessageSource = {
    kind: 'agent',
    senders: [],
    orchestration: { message: 'mail-notice', mailbox: 'mailbox', dispatchId: null, messages: [] }
  }
  const mail = { ...text('mail'), from }
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'm', body: mail }), {
    kind: 'queue-insert',
    input: { messageId: 'm', body: mail }
  })
  const fingerprint = side.memory.queuedMessages.get('m')!.fingerprint
  const input = { clientMessageId: 'send-m', payloadFingerprint: fingerprint, body: mail, fence: 1 }
  const consume = { messageId: 'm', expect: 'waiting' as const, yieldsToPause: true as const }
  await expect(
    side.run({ kind: 'submission', input, consume: { ...consume, owed: true } })
  ).rejects.toEqual(new JournalHostFactsNeededError({ mail: [mail.from] }))
  const known = { mail: [[journalMailSenderKey(mail.from), false]] as const }
  await expect(
    side.run({ kind: 'submission', input, consume: { ...consume, owed: true } }, known)
  ).rejects.toEqual(new JournalHostFactsNeededError({ owed: true }))
  // Unavailable mail is passed over, so an automatic drain may not take it.
  await expect(
    side.run(
      { kind: 'submission', input, consume: { ...consume, owed: true } },
      { mail: [[journalMailSenderKey(mail.from), true]], owed: 'owed' }
    )
  ).rejects.toBeInstanceOf(QueuedMessageNotConsumableError)
  await both(
    side,
    (j) => {
      j.queuedMessages.mailUnavailable = () => false
      return j.submissionWriter.append(input, { ...consume, owed: () => 'owed' })
    },
    { kind: 'submission', input, consume: { ...consume, owed: true } },
    { ...known, owed: 'owed' }
  )
})
