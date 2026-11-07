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
} from './store-lifecycle/journal-host-database-test-support'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import {
  createJournalStoreCollaborators,
  type JournalStoreCollaborators
} from './store-lifecycle/journal-store-collaborators'
import type { JournalHostDatabase } from './database/journal-host-database'
import { JournalWriteQueue } from './writing/journal-write-queue'
import { prepareJournalOutcomeWrite } from './outcomes/journal-outcome-write'
import { persistJournalOutcomeRows } from './outcomes/journal-outcome-table'
import {
  ensureJournalOutcomeTables,
  startJournalOutcomeLog
} from './outcomes/journal-outcome-format'
import { createJournalReducerState } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'
import {
  journalContextCursor,
  physicalJournalCursor
} from './context-epochs/journal-context-cursor'
import type { JournalRecoveryJournal } from './submissions/journal-pending-submission-recovery'
import {
  markJournalPendingSubmissionsUnknown,
  rejectJournalPendingSubmissions,
  rejectJournalQueuedSubmissions
} from './submissions/journal-pending-submission-recovery'
import { holdUnsentSends } from './queued-messages/journal-unsent-send-hold'
import { journalTombstoneRowBuilder } from './writing/journal-row-builders'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { journalSubmissionSelected } from './journal-submission-selector'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { createJournalTablesSql } from './database/journal-database-schema'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import {
  JournalHostFactsNeededError,
  journalMailSenderKey,
  type JournalWriterHostFacts
} from './journal-writer-host-facts'
import { QueuedMessageNotConsumableError } from './queued-messages/queued-message-consume-error'
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
  const recovery: JournalRecoveryJournal = {
    get inputOrder() {
      return journalInputOrder(state)
    },
    resolveDispatch: (...args) => collaborators.submissionWriter.resolveDispatch(...args),
    queuedMessages: collaborators.queuedMessages,
    physicalCursor: () => physicalJournalCursor(state),
    itemBody: (itemId) => state.items.get(itemId)?.body ?? null
  }
  return Object.assign(collaborators, {
    recovery,
    cursor: () => journalContextCursor(state),
    state: () => state
  })
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
  memory: (journal: ReturnType<typeof memoryJournal>) => Promise<T>,
  operation: JournalWriterOperation,
  facts?: Partial<JournalWriterHostFacts>
) {
  const expected = await memory(side.memory).then(
    (value) => ({ value }),
    (error: unknown) => ({ error })
  )
  const actual = await side.run(operation, facts).then(
    (commit) => ({ value: commit.value }),
    (error: unknown) => ({ error })
  )
  if ('error' in expected) {
    expect(actual).toMatchObject({ error: expect.any(Error) })
    const name = (result: { error: unknown } | { value: unknown }) =>
      'error' in result && result.error instanceof Error ? result.error.name : undefined
    expect(name(actual)).toBe(name(expected))
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

it('runs recovery procedures with serializable selectors on the writer', async () => {
  const side = await sides()
  const settled = (run: Promise<unknown>) => run.then((value) => ({ value }))
  const send = (id: string) => ({
    clientMessageId: id,
    payloadFingerprint: `fp-${id}`,
    body: text(id),
    fence: 1,
    origin: 'client' as const
  })
  for (const id of ['send-a', 'send-b', 'send-c']) {
    await both(side, (j) => j.submissionWriter.append(send(id)), {
      kind: 'submission',
      input: send(id)
    })
  }
  const pending = {
    clientMessageId: 'send-a',
    state: 'pending' as const,
    fence: 1,
    turnScope: { kind: 'thread' as const }
  }
  await both(side, (j) => j.submissionWriter.resolveDispatch(pending), {
    kind: 'dispatch',
    input: pending
  })
  await both(side, (j) => settled(markJournalPendingSubmissionsUnknown(j.recovery, 1)), {
    kind: 'pending-unknown',
    fence: 1
  })
  const only = { only: { clientMessageId: 'send-b', fence: 1 } }
  await both(
    side,
    (j) =>
      settled(
        holdUnsentSends(j.recovery, {
          fence: 1,
          hold: { cause: 'chatClosed', which: journalSubmissionSelected(only, j.cursor) }
        })
      ),
    { kind: 'hold-unsent', fence: 1, hold: { cause: 'chatClosed', select: only } }
  )
  const rejection = agentSessionFailureWords(agentSessionFailureFact('chatClosed'), {
    surface: 'rejection'
  })
  const except = { except: ['send-c'] }
  await both(
    side,
    (j) =>
      settled(
        rejectJournalQueuedSubmissions(
          j.recovery,
          1,
          rejection,
          journalSubmissionSelected(except, j.cursor)
        )
      ),
    { kind: 'queued-reject', fence: 1, rejection, select: except }
  )
  await both(side, (j) => settled(rejectJournalQueuedSubmissions(j.recovery, 1, rejection)), {
    kind: 'queued-reject',
    fence: 1,
    rejection
  })
  await both(side, (j) => settled(rejectJournalPendingSubmissions(j.recovery, 1, rejection)), {
    kind: 'pending-reject',
    fence: 1,
    rejection
  })
})

it('accepts Stop, claims goal uploads and withdraws a goal with host proofs carried as data', async () => {
  const side = await sides()
  const queued = {
    clientMessageId: 'queued-send',
    payloadFingerprint: 'fp',
    body: text('queued'),
    fence: 1,
    origin: 'client' as const
  }
  await both(side, (j) => j.submissionWriter.append(queued), { kind: 'submission', input: queued })
  const event = { reason: 'user-stop' } as const
  await both(side, (j) => j.stops.accept({ event, fence: 1, liveTurnId: () => 'turn-live' }), {
    kind: 'stop-accept',
    event,
    fence: 1,
    liveTurnId: 'turn-live'
  })
  const identity = { provider: 'orca' as const, clientMessageId: 'goal' }
  const goal = { ...text('goal'), sentAs: 'goal' as const }
  const options = { fence: 1, turnScope: { kind: 'thread' as const } }
  await both(side, (j) => j.itemAppender.appendClaimingAttachments(identity, goal, options), {
    kind: 'item-claiming',
    identity,
    body: goal,
    options
  })
  const proofs = side.memory.goalAttachments.snapshot()
  expect(proofs.goals.map(([id]) => id)).toEqual([agentJournalItemKey(identity)])
  await both(
    side,
    (j) =>
      j.rowWriter.append(
        journalTombstoneRowBuilder(j.state, agentJournalItemKey(identity), 1),
        j.goalAttachments.withdraw(agentJournalItemKey(identity))
      ),
    { kind: 'goal-withdraw', identity, fence: 1 },
    { goals: proofs }
  )
  expect(side.memory.goalAttachments.snapshot()).toEqual({ uploads: [], goals: [] })
})

it('uses the preceding handover to distinguish linked from direct unrun late settlements', async () => {
  const side = await sides()
  const rejection = agentSessionFailureWords(agentSessionFailureFact('cancelled'), {
    surface: 'rejection'
  })
  await both(side, (j) => j.queuedMessages.insert({ messageId: 'card', body: text('linked') }), {
    kind: 'queue-insert',
    input: { messageId: 'card', body: text('linked') }
  })
  for (const id of ['linked', 'direct']) {
    const input = {
      clientMessageId: id,
      payloadFingerprint:
        id === 'linked' ? side.memory.queuedMessages.get('card')!.fingerprint : 'direct-fp',
      body: text(id),
      fence: 1,
      handoverRecorded: true as const
    }
    const consume = id === 'linked' ? { messageId: 'card', expect: 'waiting' as const } : undefined
    await both(side, (j) => j.submissionWriter.append(input, consume), {
      kind: 'submission',
      input,
      consume
    })
    const settlement = {
      clientMessageId: id,
      state: 'rejected' as const,
      fence: 1,
      unrun: true as const,
      ...rejection
    }
    await both(side, (j) => j.submissionWriter.settleLate(settlement), {
      kind: 'late-dispatch',
      input: settlement
    })
  }
  expect(side.memory.state().submissions.get('linked')).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'cancelled', neverReachedAgent: true }
  })
  expect(side.memory.state().submissions.get('direct')).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'cancelled' }
  })
  expect(side.memory.state().submissions.get('direct')?.rejection).not.toHaveProperty(
    'neverReachedAgent'
  )
})
