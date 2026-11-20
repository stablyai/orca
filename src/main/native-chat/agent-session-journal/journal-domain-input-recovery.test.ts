import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import {
  applyJournalDomainInputRecovery,
  type JournalDomainInputRecoveryOperation
} from './journal-domain-input-recovery'
import {
  applyJournalDomainCommandTurn,
  type JournalDomainCommandTurnOperation
} from './journal-domain-command-turn'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionFacts
} from './journal-domain-submission-records'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { insertJournalDomainQueueRow, journalDomainQueueRow } from './journal-domain-queue-rows'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import type { JournalWriterOperation } from './journal-writer-command'
import type { ResolveDispatchInput } from './journal-store-contracts'

const target = { sessionId: 'chat', epoch: 'epoch' }
const now = 1_800_000_000_000
const cleanups: (() => void)[] = []
type Submission = Extract<JournalWriterOperation, { kind: 'submission' }>
const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const failure = agentSessionFailureWords({ kind: 'notSignedIn' }, { surface: 'rejection' })

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-domain-input-recovery-'))
  const filename = join(directory, 'journal.sqlite')
  let db = new Database(filename)
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',10,1)`).run()
  cleanups.push(() => {
    db.close()
    rmSync(directory, { recursive: true, force: true })
  })
  const facts: JournalDomainSubmissionFacts = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }
  }
  const transaction = <T>(run: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = run()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const admit = (
    id: string,
    fields: Partial<Submission['input']> = {},
    consume?: Submission['consume']
  ) => {
    const body = fields.body ?? message(id)
    return transaction(() =>
      applyJournalDomainSubmission(
        db,
        directory,
        target,
        {
          kind: 'submission',
          input: {
            clientMessageId: id,
            body,
            payloadFingerprint: agentSessionSendBodyFingerprint('chat', body),
            fence: 1,
            origin: 'client',
            source: { kind: 'user' },
            handoverRecorded: true,
            ...fields
          },
          ...(consume ? { consume } : {})
        },
        facts,
        now
      )
    )
  }
  const dispatch = (input: ResolveDispatchInput) =>
    transaction(() => applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, now + 10))
  const recover = (
    operation: JournalDomainInputRecoveryOperation,
    openedThrough?: { epoch: string; sequence: number }
  ) =>
    transaction(() =>
      applyJournalDomainInputRecovery(db, target, operation, { openedThrough }, now + 20)
    )
  const command = (operation: JournalDomainCommandTurnOperation) =>
    transaction(() => applyJournalDomainCommandTurn(db, target, operation, now + 30))
  const seed = (id: string, body = message(id)) =>
    insertJournalDomainQueueRow(db, target, {
      messageId: id,
      body,
      position: 3,
      fingerprint: agentSessionSendBodyFingerprint('chat', body),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 1 }
    })
  return {
    get db() {
      return db
    },
    transaction,
    admit,
    dispatch,
    recover,
    command,
    seed,
    restart: () => {
      db.close()
      db = new Database(filename)
    },
    attempt: (id: string) => readJournalDomainSubmissionAttempt(db, target, id),
    card: (id: string) => journalDomainQueueRow(db, target, id)?.card,
    item: (id: string) => readJournalDomainDispatchItem(db, target, id)?.item,
    head: () => ({
      epoch: 'epoch',
      sequence: Number(
        db.prepare('SELECT last_sequence FROM journal_chat_state').get()!.last_sequence
      )
    })
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('recovers only pre-open unhanded admissions after restart and leaves handed-over sends uncertain', () => {
  const f = fixture()
  f.admit('unhanded', { options: { model: 'saved-model', effort: 'high' } })
  f.admit('handed')
  f.dispatch({
    clientMessageId: 'handed',
    state: 'pending',
    turnScope: { kind: 'thread' },
    fence: 1
  })
  const openedThrough = f.head()
  const original = f.item('orca:unhanded')!
  f.transaction(() =>
    writeJournalDomainCurrentItem(f.db, target, {
      item: { ...original, sequence: 900 },
      ordinal: 11,
      hidden: false,
      ownerFence: 1
    })
  )
  f.restart()
  f.admit('newer')
  const held = f.recover(
    { kind: 'hold-unsent', fence: 1, hold: { cause: 'hostRestarted' } },
    openedThrough
  )
  expect(held.value).toEqual({ value: 11 })
  expect(f.card('unhanded')).toMatchObject({
    state: 'waiting',
    unattended: false,
    options: { model: 'saved-model', effort: 'high' }
  })
  expect(f.card('newer')).toBeUndefined()
  expect(f.attempt('newer')?.submission.dispatchState).toBe('pending')
  const unknown = f.recover({ kind: 'pending-unknown', fence: 1 })
  expect(unknown.value).toEqual({ value: ['handed'] })
  expect(f.attempt('handed')?.submission).toMatchObject({
    dispatchState: 'unknown',
    recovered: true,
    reason: 'host_restarted_before_acknowledgement'
  })
  expect(f.card('handed')).toBeUndefined()
  f.restart()
  expect(f.recover({ kind: 'pending-unknown', fence: 1 }).value).toEqual({ value: [] })
  expect(
    f.recover(
      { kind: 'hold-unsent', fence: 1, hold: { cause: 'hostRestarted' } },
      { epoch: 'other', sequence: 1000 }
    ).value
  ).toEqual({ value: null })
})

it('requeues a proven-unrun linked attempt but never requeues an uncertain handover', () => {
  const f = fixture()
  for (const id of ['unrun', 'uncertain']) {
    f.seed(`${id}-card`, message(id))
    f.admit(id, {}, { messageId: `${id}-card`, expect: 'waiting' })
    f.dispatch({ clientMessageId: id, state: 'pending', turnScope: { kind: 'thread' }, fence: 1 })
  }
  const held = f.recover({
    kind: 'hold-unsent',
    fence: 1,
    hold: { cause: 'chatClosed' },
    unrun: { only: { clientMessageId: 'unrun', fence: 1 } }
  })
  expect(held.value).toEqual({ value: 11 })
  expect(f.card('unrun-card')).toMatchObject({ state: 'waiting', consumedAs: null })
  expect(f.attempt('unrun')?.submission).toMatchObject({
    dispatchState: 'rejected',
    rejection: { kind: 'chatClosed', neverReachedAgent: true }
  })
  expect(f.card('unrun')).toBeUndefined()
  f.recover({ kind: 'pending-unknown', fence: 1, reason: 'connection ended' })
  expect(f.card('uncertain-card')).toMatchObject({ state: 'dispatched', consumedAs: 'uncertain' })
  expect(f.attempt('uncertain')?.submission).toMatchObject({
    dispatchState: 'unknown',
    reason: 'connection ended'
  })
})

it('fronts current unlinked sends while preserving an explicit linked card and remains stable on reopen', () => {
  const f = fixture()
  f.seed('H')
  f.seed('C')
  f.db.prepare("UPDATE journal_queue_cards SET position=4 WHERE message_id='C'").run()
  f.admit('A')
  f.admit('H-handoff', { body: message('H') }, { messageId: 'H', expect: 'waiting' })
  f.admit('B')
  const order = () =>
    f.db
      .prepare(
        "SELECT message_id FROM journal_queue_cards WHERE state='waiting' ORDER BY position,message_id"
      )
      .all()
      .map((row) => row.message_id)
  f.recover({ kind: 'hold-unsent', fence: 1, hold: { cause: 'hostRestarted' } }, f.head())
  expect(order()).toEqual(['A', 'B', 'H', 'C'])
  f.restart()
  f.recover({ kind: 'hold-unsent', fence: 1, hold: { cause: 'hostRestarted' } }, f.head())
  expect(order()).toEqual(['A', 'B', 'H', 'C'])
})

it('keeps only admitted personal input or commands and never defaults an unknown source to personal', () => {
  const f = fixture()
  f.admit('personal', { source: undefined })
  f.admit('automatic', { source: { kind: 'agent' } })
  f.db
    .prepare(`UPDATE journal_submission_attempts SET facts_json=json_set(facts_json,'$.admission.sourceKind','future-source'),
    payload_json=json_set(payload_json,'$.source.kind','future-source') WHERE message_id='automatic'`)
    .run()
  f.admit('command', {
    origin: 'host',
    source: { kind: 'agent' },
    body: { ...message('compact'), command: { name: 'compact' } }
  })
  const result = f.recover({ kind: 'hold-unsent', fence: 1, hold: { cause: 'chatClosed' } })
  expect(result.cards.map((card) => card.messageId)).toEqual(['personal', 'command'])
  expect(f.card('automatic')).toBeUndefined()
  expect(f.card('command')?.unattended).toBe(true)
  expect(f.attempt('automatic')?.submission.dispatchState).toBe('rejected')
})

it('finishes recovery beyond the first keyset page without selecting settled history', () => {
  const f = fixture()
  f.admit('accepted', { handoverRecorded: undefined })
  f.dispatch({
    clientMessageId: 'accepted',
    state: 'accepted',
    providerIdentity: { provider: 'codex', threadId: 'thread', turnId: 'turn', ordinal: 0 },
    fence: 1
  })
  for (let index = 0; index < 65; index++) {
    f.admit(`send-${index}`, { handoverRecorded: undefined })
  }
  const result = f.recover({ kind: 'pending-unknown', fence: 1 })
  expect(result.value).toMatchObject({ value: expect.arrayContaining(['send-0', 'send-64']) })
  expect(f.attempt('send-64')?.submission).toMatchObject({
    dispatchState: 'unknown',
    recovered: true
  })
  expect(f.attempt('accepted')?.submission.dispatchState).toBe('accepted')
  expect(result.receipts).toEqual([])
})

it('preserves typed rejections, prior unknown reasons, and exact queued selectors', () => {
  const f = fixture()
  f.admit('pending', { handoverRecorded: undefined })
  f.admit('unknown', { handoverRecorded: undefined })
  f.dispatch({ clientMessageId: 'unknown', state: 'unknown', reason: 'earlier doubt', fence: 1 })
  f.recover({ kind: 'pending-unknown', fence: 1, reason: 'later doubt' })
  expect(f.attempt('unknown')?.submission.reason).toBe('earlier doubt')
  f.admit('rejected', { handoverRecorded: undefined })
  expect(f.recover({ kind: 'pending-reject', fence: 1, rejection: failure }).value).toEqual({
    value: ['rejected']
  })
  expect(f.attempt('rejected')?.submission.rejection).toEqual({
    kind: 'notSignedIn'
  })
  for (const id of ['selected', 'excepted', 'later']) {
    f.admit(id)
  }
  const through = { epoch: 'epoch', sequence: f.attempt('excepted')!.submission.acceptedSequence! }
  const rejected = f.recover({
    kind: 'queued-reject',
    fence: 1,
    rejection: failure,
    select: { acceptedThrough: through, except: ['excepted'] }
  })
  expect(rejected.value).toEqual({ value: ['selected'] })
  expect(f.attempt('excepted')?.submission.dispatchState).toBe('pending')
  expect(f.attempt('later')?.submission.dispatchState).toBe('pending')
  expect(
    f.recover({
      kind: 'queued-reject',
      fence: 1,
      rejection: failure,
      select: { only: { clientMessageId: 'later', fence: 9 } }
    }).value
  ).toEqual({ value: [] })
})

it('keeps the pending-recovery prefix and omits failed or unattempted payloads', () => {
  const f = fixture()
  for (const id of ['first', 'broken', 'last']) {
    f.admit(id, { handoverRecorded: undefined })
  }
  f.db
    .exec(`CREATE TRIGGER reject_middle BEFORE UPDATE OF payload_json ON journal_submission_attempts
    WHEN NEW.message_id='broken' BEGIN SELECT RAISE(ABORT, 'dispatch unavailable'); END`)
  const result = f.recover({ kind: 'pending-reject', fence: 1, rejection: failure })
  expect(JSON.parse(JSON.stringify(result.value))).toMatchObject({
    failure: { message: 'dispatch unavailable' }
  })
  expect(f.attempt('first')?.submission.dispatchState).toBe('rejected')
  expect(f.attempt('broken')?.submission.dispatchState).toBe('pending')
  expect(f.attempt('last')?.submission.dispatchState).toBe('pending')
  expect(
    result.coordinates.map((entry) =>
      'clientMessageId' in entry ? entry.clientMessageId : undefined
    )
  ).toEqual(['first'])
  expect(result.items.map((item) => item.itemId)).toEqual(['orca:first'])
})

it('rolls back a failed kept card with its rejection and still tries every other close obligation', () => {
  const f = fixture()
  for (const id of ['first', 'broken', 'last']) {
    f.admit(id)
  }
  f.db
    .exec(`CREATE TRIGGER reject_middle BEFORE UPDATE OF payload_json ON journal_submission_attempts
    WHEN NEW.message_id='broken' BEGIN SELECT RAISE(ABORT, 'dispatch unavailable'); END`)
  const result = f.recover({ kind: 'hold-unsent', fence: 1, hold: { cause: 'chatClosed' } })
  expect(result.value).toMatchObject({
    failure: { name: 'AggregateError', message: 'settling unsent sends failed' }
  })
  expect(f.card('first')?.state).toBe('waiting')
  expect(f.card('broken')).toBeUndefined()
  expect(f.attempt('broken')?.submission.dispatchState).toBe('pending')
  expect(f.card('last')?.state).toBe('waiting')
  expect(result.cards.map((card) => card.messageId)).toEqual(['first', 'last'])
  expect(result.cursor).toEqual(f.head())
  f.restart()
  expect(f.card('broken')).toBeUndefined()
})

it('preserves command handover when the running-turn write fails, then returns the committed turn on retry', () => {
  const f = fixture()
  f.admit('command')
  f.db.exec(`CREATE TRIGGER reject_turn BEFORE INSERT ON journal_items
    WHEN NEW.kind='turn' BEGIN SELECT RAISE(ABORT, 'turn unavailable'); END`)
  const operation: JournalDomainCommandTurnOperation = {
    kind: 'command-open',
    input: {
      clientMessageId: 'command',
      fence: 1,
      turnScope: { kind: 'thread' },
      submittedAt: now - 10
    }
  }
  const failed = f.command(operation)
  expect(failed.value).toMatchObject({ failure: { message: 'turn unavailable' } })
  expect(f.attempt('command')?.handover).toMatchObject({ at: now + 30, scope: { kind: 'thread' } })
  expect(f.item('orca:command-turn%3Acommand')).toBeUndefined()
  expect(failed.coordinates.map((entry) => entry.kind)).toEqual(['dispatch'])
  f.db.exec('DROP TRIGGER reject_turn')
  const opened = f.command(operation)
  expect(opened.value).toMatchObject({
    value: {
      running: { kind: 'turn', state: 'running', requestedAt: now + 30, startedAt: now + 30 }
    }
  })
  expect(opened.items.at(-1)).toEqual(f.item('orca:command-turn%3Acommand'))
})

it('commits command dispatch first and rolls back its whole result/turn settlement before retry', () => {
  const f = fixture()
  const body: AgentJournalMessageItem = { ...message('compact'), command: { name: 'compact' } }
  f.seed('command-card', body)
  f.admit('command', { body }, { messageId: 'command-card', expect: 'waiting' })
  f.command({
    kind: 'command-open',
    input: { clientMessageId: 'command', fence: 1, turnScope: { kind: 'thread' }, submittedAt: now }
  })
  const turn = structuredAgentSessionCommandTurn('command')
  const before = f.item(turn.itemId)!
  f.db.exec(`CREATE TRIGGER reject_terminal BEFORE UPDATE ON journal_items
    WHEN NEW.kind='turn' AND json_extract(NEW.payload_json,'$.body.state')='completed'
    BEGIN SELECT RAISE(ABORT, 'settlement unavailable'); END`)
  const operation: JournalDomainCommandTurnOperation = {
    kind: 'command-settle',
    input: {
      dispatch: { clientMessageId: 'command', state: 'rejected', ...failure, fence: 1 },
      failureBody: { kind: 'status', text: 'Command failed', tone: 'error' }
    }
  }
  const failed = f.command(operation)
  expect(failed.value).toMatchObject({ failure: { message: 'settlement unavailable' } })
  expect(f.attempt('command')?.submission.dispatchState).toBe('rejected')
  expect(f.card('command-card')?.state).toBe('withdrawn')
  expect(f.item(turn.itemId)).toEqual(before)
  expect(f.item('orca:command-result%3Acommand')).toBeUndefined()
  expect(failed.items.some((item) => item.itemId === turn.itemId)).toBe(false)
  f.db.exec('DROP TRIGGER reject_terminal')
  const settled = f.command(operation)
  expect(settled.value).toEqual({ value: undefined })
  expect(f.item(turn.itemId)).toMatchObject({
    sequence: before.sequence,
    observedAt: before.observedAt,
    body: { state: 'completed', outcome: 'failure', completedAt: now + 30 }
  })
  expect(f.item('orca:command-result%3Acommand')).toMatchObject({
    turnScope: { kind: 'turn', turnItemId: turn.itemId },
    body: { tone: 'error' }
  })
  expect(settled.items).toContainEqual(f.item(turn.itemId))
  f.restart()
  expect(f.item(turn.itemId)?.body).toMatchObject({ state: 'completed', outcome: 'failure' })
})

it('makes an uncertain command turn unverifiable without manufacturing a failure result', () => {
  const f = fixture()
  f.admit('command')
  f.command({
    kind: 'command-open',
    input: { clientMessageId: 'command', fence: 1, turnScope: { kind: 'thread' }, submittedAt: now }
  })
  const result = f.command({
    kind: 'command-settle',
    input: {
      dispatch: { clientMessageId: 'command', fence: 1, state: 'unknown', reason: 'reply lost' },
      failureBody: { kind: 'status', text: 'unused', tone: 'error' }
    }
  })
  expect(result.value).toEqual({ value: undefined })
  expect(f.item('orca:command-turn%3Acommand')?.body).toMatchObject({ state: 'unverifiable' })
  expect(f.item('orca:command-result%3Acommand')).toBeUndefined()
})
