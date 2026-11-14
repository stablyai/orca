import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainDispatch } from './journal-domain-dispatch'
import {
  readJournalDomainSubmissionAttempt,
  type JournalDomainSubmissionFacts
} from './journal-domain-submission-records'
import { readJournalDomainDispatchItem } from './journal-domain-dispatch-placement'
import { applyJournalDomainItem } from './journal-domain-item'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'
import {
  journalDomainQueueRow,
  insertJournalDomainQueueRow,
  placeJournalDomainQueueRow
} from './journal-domain-queue-rows'
import {
  applyJournalDomainEditLease,
  type JournalDomainEditLeaseOperation
} from './journal-domain-edit-leases'
import type { JournalWriterOperation } from './journal-writer-command'
import type { ResolveDispatchInput } from './journal-store-contracts'
import { ensureCommandReceiptsTable } from './writing/command-receipt-schema'
import { insertCommandReceiptIfAbsent, readCommandReceipt } from './writing/command-receipt-table'
import { commandReceiptFixture } from './writing/command-receipt-test-support'
import {
  QueuedMessageNotConsumableError,
  QueuedMessageNotOwedError
} from './queued-messages/queued-message-consume-error'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { agentSessionAttachmentStoreRoot } from '../agent-session-attachments/agent-session-attachment-references'

const target = { sessionId: 'chat', epoch: 'epoch' }
const now = 1_800_000_000_000
const cleanups: (() => void)[] = []
const body = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
type Submission = Extract<JournalWriterOperation, { kind: 'submission' }>

function fixture() {
  const db = new Database(':memory:')
  const stateDirectory = mkdtempSync(join(tmpdir(), 'orca-domain-submission-'))
  cleanups.push(() => {
    db.close()
    rmSync(stateDirectory, { recursive: true, force: true })
  })
  migrateJournalDomainSchema(db)
  ensureAgentSessionAttachmentClaimTables(db)
  db.prepare(
    `INSERT INTO journal_chat_state(workspace_id,session_id,epoch,last_sequence,highest_fence) VALUES('workspace','chat','epoch',10,1)`
  ).run()
  const facts: JournalDomainSubmissionFacts = {
    identity: {
      sessionId: 'chat',
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'codex',
      providerHandle: codexProviderHandle('thread')
    }
  }
  const transaction = <T>(write: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const value = write()
      db.exec('COMMIT')
      return value
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  const submit = (
    id: string,
    fields: Partial<Submission['input']> = {},
    consume?: Submission['consume']
  ): Submission => {
    const message = fields.body ?? body(id)
    return {
      kind: 'submission',
      input: {
        clientMessageId: id,
        body: message,
        payloadFingerprint: agentSessionSendBodyFingerprint('chat', message),
        fence: 1,
        handoverRecorded: true,
        origin: 'client',
        source: { kind: 'user' },
        ...fields
      },
      ...(consume ? { consume } : {})
    }
  }
  const admit = (operation: Submission, supplied = facts, savedAt = now) =>
    transaction(() =>
      applyJournalDomainSubmission(db, stateDirectory, target, operation, supplied, savedAt)
    )
  const dispatch = (input: ResolveDispatchInput) =>
    transaction(() => applyJournalDomainDispatch(db, target, { kind: 'dispatch', input }, now + 10))
  const seed = (id: string, fields: Partial<QueuedMessageRow> = {}) => {
    const message = fields.body ?? body(id)
    insertJournalDomainQueueRow(db, target, {
      messageId: id,
      body: message,
      position: 1,
      fingerprint: agentSessionSendBodyFingerprint('chat', message),
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: { epoch: 'epoch', sequence: 1 },
      ...fields
    })
  }
  const lease = (operation: JournalDomainEditLeaseOperation, time = now) =>
    transaction(() => applyJournalDomainEditLease(db, target, 'handle', operation, time))
  const attempt = (id: string) => readJournalDomainSubmissionAttempt(db, target, id)
  const item = (id: string) => readJournalDomainDispatchItem(db, target, `orca:${id}`)
  const card = (id: string) => journalDomainQueueRow(db, target, id)?.card
  const head = () =>
    Number(db.prepare('SELECT last_sequence FROM journal_chat_state').get()!.last_sequence)
  return {
    db,
    stateDirectory,
    facts,
    transaction,
    submit,
    admit,
    dispatch,
    seed,
    lease,
    attempt,
    item,
    card,
    head
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

it('manual Send preserves provenance and retires overlapping edit holds only when consumed', () => {
  const f = fixture()
  const message: AgentJournalMessageItem = {
    ...body('mail'),
    from: { kind: 'agent', senders: [], orchestration: null }
  }
  f.seed('card', {
    body: message,
    deliveryMode: 'steer',
    unattended: true,
    options: { model: 'queued-model', effort: 'high' }
  })
  const fingerprint = agentSessionSendBodyFingerprint('chat', message)
  expect(() =>
    f.admit(
      f.submit('stale', { body: body('old version') }, { messageId: 'card', expect: 'waiting' })
    )
  ).toThrow(QueuedMessageNotConsumableError)
  for (const callerKey of ['desktop', 'phone']) {
    f.lease({ kind: 'acquire', callerKey, editId: callerKey, messageId: 'card', fingerprint })
  }
  const operation = f.submit(
    'send',
    { body: message, options: { model: 'chosen-model' }, source: { kind: 'agent' } },
    { messageId: 'card', expect: 'waiting', owed: true }
  )
  f.lease({ kind: 'release', callerKey: 'desktop', editId: 'desktop', messageId: 'card' })
  f.transaction(() => placeJournalDomainQueueRow(f.db, target, 'card', 9))
  const explicit = operation
  const admitted = f.admit(explicit, { ...f.facts, owed: 'owed' })
  expect(admitted).toMatchObject({
    cursor: { sequence: 11 },
    items: [{ revision: 0, sequence: 11, body: message }],
    editDeadline: null
  })
  expect(f.attempt('send')).toMatchObject({
    ordinal: 0,
    admittedPersonal: false,
    admission: {
      body: message,
      familyId: 'card',
      sourceKind: 'agent',
      options: { model: 'chosen-model' }
    }
  })
  expect(f.card('card')).toMatchObject({
    position: 9,
    state: 'dispatched',
    consumedAs: 'send',
    body: message,
    deliveryMode: 'steer',
    unattended: true,
    options: { model: 'queued-model', effort: 'high' }
  })
  expect(
    f.lease({ kind: 'renew', callerKey: 'phone', editId: 'phone', messageId: 'card' }).result
  ).toEqual({ status: 'expired' })
  expect(() => f.admit(explicit)).toThrow(/already recorded/)
  expect(f.head()).toBe(11)
})

it('manual Send checks owed authority and appends ordered reopen/admission identities', () => {
  const f = fixture()
  f.seed('card')
  f.lease(
    {
      kind: 'acquire',
      callerKey: 'phone',
      editId: 'edit',
      messageId: 'card',
      fingerprint: agentSessionSendBodyFingerprint('chat', body('card'))
    },
    now - 120_000
  )
  const operation = f.submit(
    'send',
    { body: body('card') },
    { messageId: 'card', expect: 'waiting', owed: true }
  )
  f.db
    .prepare(`UPDATE journal_chat_state SET queue_manual_stop_json=?`)
    .run(JSON.stringify({ sequence: 9, event: { reason: 'user-stop', at: now } }))
  f.db.prepare(`UPDATE journal_chat_state SET queue_resumed_sequence=10`).run()
  const reopened = {
    ...f.facts,
    reopenFloor: { epoch: 'epoch', sequence: 10 },
    owed: 'unavailable' as const
  }
  expect(() => f.admit(operation, reopened)).toThrow(QueuedMessageNotOwedError)
  expect(f.head()).toBe(10)
  const admitted = f.admit(operation, { ...reopened, owed: 'owed' })
  expect(admitted.coordinates).toEqual([
    { kind: 'queue-reopen', cursor: { epoch: 'epoch', sequence: 11 }, fence: 1, observedAt: now },
    {
      kind: 'submission',
      cursor: { epoch: 'epoch', sequence: 12 },
      fence: 1,
      observedAt: now,
      clientMessageId: 'send'
    }
  ])
  expect(f.attempt('send')).toMatchObject({
    admittedPersonal: true,
    sequence: 12,
    submission: { submittedSequence: 12, acceptedSequence: 12 }
  })
  expect(
    f.db
      .prepare('SELECT sequence,changes_json FROM journal_events ORDER BY sequence')
      .all()
      .map((row) => [row.sequence, JSON.parse(String(row.changes_json))])
  ).toEqual([
    [11, { items: [], submissions: [], cards: [] }],
    [
      12,
      {
        items: [{ itemId: 'orca:send', revision: 0, sequence: 12, sequenceIndex: 0 }],
        submissions: ['send'],
        cards: ['card']
      }
    ]
  ])
})

it.each(['dispatch-first', 'echo-first'])(
  'converges %s acceptance on one optimistic body, alias and receipt after handover',
  (order) => {
    const f = fixture()
    f.admit(f.submit('send', { body: body('original') }))
    f.transaction(() =>
      applyJournalDomainItem(
        f.db,
        target,
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: 'intervening' },
          body: { ...body('work'), role: 'assistant' },
          options: { fence: 1, turnScope: { kind: 'thread' } }
        },
        now + 1
      )
    )
    f.dispatch({
      clientMessageId: 'send',
      fence: 1,
      state: 'pending',
      turnScope: { kind: 'thread' },
      carries: ['stopped']
    })
    const echo = () =>
      f.transaction(() =>
        applyJournalDomainItem(
          f.db,
          target,
          {
            kind: 'item',
            identity: { provider: 'claude', sessionId: 'provider', uuid: 'echo' },
            body: body('original'),
            options: { fence: 1, turnScope: { kind: 'thread' } }
          },
          now + 20
        )
      )
    const accepted = {
      clientMessageId: 'send',
      fence: 1,
      state: 'accepted' as const,
      providerIdentity: { provider: 'claude' as const, sessionId: 'provider', uuid: 'echo' }
    }
    if (order === 'dispatch-first') {
      f.dispatch(accepted)
      echo()
    } else {
      echo()
      f.dispatch(accepted)
    }
    expect(f.item('send')).toMatchObject({
      item: { sequence: 13, observedAt: now + 10, body: body('original') }
    })
    expect(f.attempt('send')).toMatchObject({
      ordinal: 0,
      handover: { sequence: 13 },
      carries: ['stopped'],
      submission: { dispatchState: 'accepted', providerItemId: 'claude:provider:echo' }
    })
    expect(f.db.prepare('SELECT provider_item_id,item_id FROM journal_item_aliases').all()).toEqual(
      [{ provider_item_id: 'claude:provider:echo', item_id: 'orca:send' }]
    )
    expect(
      f.db
        .prepare('SELECT message_id,payload_json FROM journal_send_receipts')
        .all()
        .map((row) => [row.message_id, JSON.parse(String(row.payload_json))])
    ).toEqual([
      [
        'send',
        {
          clientMessageId: 'send',
          providerItemId: 'claude:provider:echo',
          cursor: { epoch: 'epoch', sequence: 14 },
          acceptedAt: order === 'dispatch-first' ? now + 10 : now + 20
        }
      ]
    ])
    const late = f.transaction(() =>
      applyJournalDomainDispatch(f.db, target, { kind: 'accept-late', input: accepted }, now + 30)
    )
    expect(late).toMatchObject({
      cursor: { sequence: 15 },
      value: undefined,
      coordinates: [],
      items: [],
      inputChanged: false
    })
  }
)

it('matches a changed provider echo after acceptance once, without claiming the next identical send', () => {
  const f = fixture()
  f.admit(f.submit('first', { body: body('same') }))
  f.dispatch({
    clientMessageId: 'first',
    fence: 1,
    state: 'accepted',
    providerIdentity: { provider: 'claude', sessionId: 'provider', uuid: 'accepted-id' }
  })
  const echo = (uuid: string) =>
    f.transaction(() =>
      applyJournalDomainItem(
        f.db,
        target,
        {
          kind: 'item',
          identity: { provider: 'claude', sessionId: 'provider', uuid },
          body: body('same'),
          options: { fence: 1, turnScope: { kind: 'thread' } }
        },
        now + 20
      )
    )
  expect(echo('actual-echo').items[0]?.itemId).toBe('orca:first')
  expect(
    f.db
      .prepare(`SELECT echo_observed,admission_body_json,signed_out,dispatch_fence
    FROM journal_submission_attempts WHERE message_id='first'`)
      .get()
  ).toEqual({
    echo_observed: 1,
    admission_body_json:
      '{"kind":"message","role":"user","blocks":[{"type":"text","text":"same"}]}',
    signed_out: 0,
    dispatch_fence: 1
  })
  f.admit(f.submit('second', { body: body('same') }))
  expect(echo('second-echo').items[0]?.itemId).toBe('orca:second')
  expect(f.db.prepare('SELECT item_id FROM journal_items ORDER BY ordinal').all()).toEqual([
    { item_id: 'orca:first' },
    { item_id: 'orca:second' }
  ])
})

it('keeps effective handover scope separate from placement and replaces carried coverage on rebind', () => {
  const f = fixture()
  f.transaction(() =>
    applyJournalDomainItem(
      f.db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'turn' },
        body: { kind: 'turn', turnId: 'provider-turn', state: 'running' },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      },
      now
    )
  )
  f.seed('card')
  f.admit(f.submit('send', { body: body('card') }, { messageId: 'card', expect: 'waiting' }))
  f.dispatch({
    clientMessageId: 'send',
    fence: 1,
    state: 'pending',
    turnScope: { kind: 'thread' },
    carries: ['old']
  })
  expect(f.attempt('send')).toMatchObject({
    handover: {
      sequence: 13,
      scope: { kind: 'turn', turnItemId: 'orca:turn' }
    },
    handoverPlace: { sequence: 13, scope: { kind: 'thread' } },
    carries: ['old']
  })
  f.dispatch({
    clientMessageId: 'send',
    fence: 1,
    state: 'pending',
    turnScope: { kind: 'thread' },
    carries: []
  })
  expect(f.attempt('send')).toMatchObject({
    ordinal: 0,
    handover: { sequence: 14, scope: { kind: 'turn', turnItemId: 'orca:turn' } },
    carries: []
  })
  expect(f.item('send')).toMatchObject({
    item: { revision: 0, sequence: 14, turnScope: { kind: 'thread' } }
  })
})

it('keeps a restored presentation through an itemless handover replacement and restores it on uncertain rejection', () => {
  const f = fixture()
  f.seed('card')
  f.admit(f.submit('send', { body: body('card') }, { messageId: 'card', expect: 'waiting' }))
  f.db.exec(`UPDATE journal_submission_attempts SET handover_fence=1,facts_json=json_set(facts_json,
      '$.handover',json('{"sequence":8,"at":80,"fence":1,"scope":{"kind":"thread"}}'),
      '$.handoverPlace',json('{"sequence":7,"at":70,"scope":{"kind":"turn","turnItemId":"orca:past"}}'))
      WHERE message_id='send';
    DELETE FROM journal_items WHERE item_id='orca:send'`)
  f.dispatch({ clientMessageId: 'send', fence: 1, state: 'pending', turnScope: { kind: 'thread' } })
  expect(f.attempt('send')).toMatchObject({
    handover: { sequence: 12, at: now + 10 },
    handoverPlace: { sequence: 7, at: 70, scope: { kind: 'turn', turnItemId: 'orca:past' } }
  })
  f.transaction(() =>
    applyJournalDomainItem(
      f.db,
      target,
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'send' },
        body: body('card'),
        options: { fence: 1, turnScope: { kind: 'thread' } }
      },
      now
    )
  )
  f.dispatch({
    clientMessageId: 'send',
    fence: 1,
    state: 'rejected',
    ...agentSessionFailureWords(
      { kind: 'unconfirmed' },
      { surface: 'rejection', agentName: 'Codex' }
    )
  })
  expect(f.item('send')).toMatchObject({
    item: { sequence: 7, observedAt: 70, turnScope: { kind: 'turn', turnItemId: 'orca:past' } }
  })
  expect(f.card('card')).toMatchObject({ state: 'dispatched', consumedAs: 'send' })
})

it('keeps an uncertain queued rejection spent at handover with its original rejection, and a genuine later attempt retains its own admission', () => {
  const f = fixture()
  f.seed('card')
  f.admit(f.submit('first', { body: body('card') }, { messageId: 'card', expect: 'waiting' }))
  f.dispatch({
    clientMessageId: 'first',
    fence: 1,
    state: 'pending',
    turnScope: { kind: 'thread' }
  })
  f.dispatch({
    clientMessageId: 'first',
    fence: 1,
    state: 'rejected',
    ...agentSessionFailureWords(
      { kind: 'unconfirmed' },
      { surface: 'rejection', agentName: 'Codex' }
    )
  })
  expect(f.card('card')).toMatchObject({ state: 'dispatched', consumedAs: 'first' })
  expect(f.item('first')).toMatchObject({ hidden: false, item: { sequence: 12 } })
  expect(f.attempt('first')).toMatchObject({
    ordinal: 0,
    presentationMember: true,
    normalizedHandOff: true,
    submission: { dispatchState: 'unknown', recovered: true },
    rejection: {
      sequence: 13,
      fact: { kind: 'unconfirmed' },
      answeredInTurn: null
    }
  })
  expect(f.attempt('first')!.submission.rejection).toBeUndefined()
  f.transaction(() =>
    applyJournalDomainQueueCommand(
      f.db,
      f.stateDirectory,
      target,
      { kind: 'queue-insert', input: { messageId: 'another', body: body('later') } },
      now
    )
  )
  f.admit(f.submit('later', { body: body('later') }, { messageId: 'another', expect: 'waiting' }))
  expect(f.attempt('later')).toMatchObject({
    ordinal: 1,
    sequence: 15,
    admission: { body: body('later'), familyId: 'another' }
  })
  expect(f.attempt('first')).toMatchObject({
    ordinal: 0,
    sequence: 11,
    admission: { body: body('card') }
  })
})

it('requeues only proven unrun delivery, keeps typed refusals and answered turns, and ignores late acceptance after terminal refusal', () => {
  const f = fixture()
  f.seed('card')
  f.admit(f.submit('first', { body: body('card') }, { messageId: 'card', expect: 'waiting' }))
  f.dispatch({
    clientMessageId: 'first',
    fence: 1,
    state: 'pending',
    turnScope: { kind: 'thread' }
  })
  f.transaction(() =>
    applyJournalDomainDispatch(
      f.db,
      target,
      {
        kind: 'late-dispatch',
        input: {
          clientMessageId: 'first',
          fence: 1,
          state: 'rejected',
          ...agentSessionFailureWords(
            { kind: 'cancelled' },
            { surface: 'rejection', agentName: 'Codex' }
          ),
          unrun: true
        }
      },
      now
    )
  )
  expect(f.card('card')).toMatchObject({ state: 'waiting', consumedAs: null })
  expect(f.item('first')).toMatchObject({ item: { sequence: 13, turnScope: { kind: 'thread' } } })
  f.admit(f.submit('second', { body: body('card') }, { messageId: 'card', expect: 'waiting' }))
  f.dispatch({
    clientMessageId: 'second',
    fence: 1,
    state: 'pending',
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
  const settled = f.dispatch({
    clientMessageId: 'second',
    fence: 2,
    state: 'rejected',
    ...agentSessionFailureWords(
      { kind: 'notSignedIn', neverReachedAgent: true },
      { surface: 'rejection', agentName: 'Codex' }
    ),
    keptAsQueuedMessageId: 'kept',
    answeredInTurn: { turn: { provider: 'orca', clientMessageId: 'turn' }, via: 'steer' }
  })
  expect(settled.cards).toMatchObject([
    {
      state: 'returned',
      consumedAs: 'second',
      returnedRejection: { kind: 'notSignedIn', neverReachedAgent: true }
    }
  ])
  expect(f.attempt('second')).toMatchObject({
    ordinal: 1,
    submission: {
      keptAsQueuedMessageId: 'kept',
      answeredInTurn: { turnItemId: 'orca:turn', via: 'steer' }
    }
  })
  expect(
    f.db
      .prepare(
        `SELECT dispatch_fence,signed_out FROM journal_submission_attempts WHERE message_id='second'`
      )
      .get()
  ).toEqual({ dispatch_fence: 2, signed_out: 1 })
  const late = f.transaction(() =>
    applyJournalDomainDispatch(
      f.db,
      target,
      {
        kind: 'accept-late',
        input: { clientMessageId: 'second', fence: 1, state: 'accepted', providerIdentity: null }
      },
      now
    )
  )
  expect(late.coordinates).toEqual([])
  expect(f.head()).toBe(16)
  const ignored = f.dispatch({ clientMessageId: 'second', fence: 2, state: 'unknown' })
  expect(ignored).toMatchObject({
    cursor: { sequence: 17 },
    value: { sequence: 17 },
    inputChanged: false,
    coordinates: [{ kind: 'dispatch', cursor: { sequence: 17 } }]
  })
  const skipped = f.transaction(() =>
    applyJournalDomainDispatch(
      f.db,
      target,
      {
        kind: 'dispatch',
        onlyIfUnsettled: true,
        input: { clientMessageId: 'second', fence: 1, state: 'unknown' }
      },
      now
    )
  )
  expect(skipped).toMatchObject({ cursor: { sequence: 17 }, value: null, coordinates: [] })
  expect(f.attempt('first')).toMatchObject({
    ordinal: 0,
    admission: { body: body('card') },
    submission: { dispatchState: 'rejected' }
  })
})

it('binds the receipt to the actual admission and rolls back a failing command suffix while committing its successful prefix', () => {
  const f = fixture()
  const uploadId = '0b6f8a52-4a3e-4c4e-9a59-1d5d1f2b8c01'
  const carried: AgentJournalMessageItem = {
    ...body('carried'),
    blocks: [
      {
        type: 'image-ref',
        path: join(agentSessionAttachmentStoreRoot(f.stateDirectory), uploadId, 'shot.png')
      }
    ]
  }
  ensureCommandReceiptsTable(f.db)
  f.db.prepare(`INSERT INTO agent_session_records VALUES('chat','{}')`).run()
  const scope = { kind: 'caller' as const, callerKey: 'caller-1' }
  const bind = (operationId: string, sequence: number) =>
    insertCommandReceiptIfAbsent(
      f.db,
      scope,
      commandReceiptFixture({
        operationId,
        sessionId: 'chat',
        result: { kind: 'journal-row', epoch: 'epoch', sequence }
      })
    )
  f.transaction(() => {
    const accepted = applyJournalDomainSubmission(
      f.db,
      f.stateDirectory,
      target,
      f.submit('prefix'),
      f.facts,
      now
    )
    expect(bind('prefix', accepted.coordinates.at(-1)!.cursor.sequence)).toEqual({ inserted: true })
    f.db.exec(
      `CREATE TEMP TRIGGER reject_suffix BEFORE INSERT ON journal_events WHEN NEW.sequence=13 BEGIN SELECT RAISE(ABORT,'event append refused'); END`
    )
    f.db.exec('SAVEPOINT command')
    expect(() => {
      const first = applyJournalDomainSubmission(
        f.db,
        f.stateDirectory,
        target,
        f.submit('rolled-back', { origin: 'host', body: carried }),
        f.facts,
        now
      )
      bind('rolled-back', first.coordinates.at(-1)!.cursor.sequence)
      expect(first.referencedUploads).toEqual([uploadId])
      expect(f.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([
        { upload_id: uploadId }
      ])
      applyJournalDomainDispatch(
        f.db,
        target,
        {
          kind: 'dispatch',
          input: {
            clientMessageId: 'rolled-back',
            fence: 1,
            state: 'accepted',
            providerIdentity: null
          }
        },
        now
      )
      applyJournalDomainSubmission(
        f.db,
        f.stateDirectory,
        target,
        f.submit('never-run'),
        f.facts,
        now
      )
    }).toThrow('event append refused')
    f.db.exec('ROLLBACK TO command; RELEASE command')
  })
  expect(f.head()).toBe(11)
  expect(f.item('prefix')?.item.body).toEqual(body('prefix'))
  expect(f.attempt('rolled-back')).toBeNull()
  expect(f.item('rolled-back')).toBeNull()
  expect(f.attempt('never-run')).toBeNull()
  expect(f.db.prepare('SELECT upload_id FROM agent_session_attachment_claims').all()).toEqual([])
  expect(readCommandReceipt(f.db, scope, 'prefix')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', epoch: 'epoch', sequence: 11 } }
  })
  expect(readCommandReceipt(f.db, scope, 'rolled-back')).toEqual({ verdict: 'absent' })
})
