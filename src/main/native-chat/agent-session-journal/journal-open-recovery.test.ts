import { afterEach, expect, it } from 'vitest'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { automaticBody } from './journal-automatic-submission.test-fixture'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { JournalSqlScope } from './journal-sql-scope'
import { nextJournalDomainQueueCard } from './journal-domain-submission-consume'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { readJournalDomainQueuePauses } from './journal-domain-queue-reads'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

async function fixture() {
  const f = domainLifecycleFixture(cleanups)
  f.db
    .prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
    .run(
      'chat',
      JSON.stringify(encodeAgentSessionRecord(agentSessionRecordFixture({ sessionId: 'chat' })))
    )
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'handed',
      body: automaticBody('already handed over'),
      payloadFingerprint: 'handed',
      fence: 1,
      origin: 'host'
    }
  })
  await f.run({
    kind: 'submission',
    input: {
      clientMessageId: 'unsent',
      body: automaticBody('keep my text'),
      payloadFingerprint: 'unsent',
      fence: 1,
      handoverRecorded: true,
      origin: 'host',
      source: { kind: 'user' }
    }
  })
  const scope = new JournalSqlScope(f.db, 'chat', 'epoch')
  return { ...f, scope }
}

it('opens at its original boundary, recovers sends and holds the recovered personal card before readers', async () => {
  const f = await fixture()
  const opened = await f.run({ kind: 'open', recover: { fence: 1 } })
  expect(opened.value).toEqual({ epoch: 'epoch', sequence: 2 })
  expect(opened.openRecovery).toEqual({ failures: [], reopenFloor: null })
  expect(readJournalDomainQueuePauses(f.db, f.scope, null).map((pause) => pause.reason)).toEqual([
    'restarted'
  ])
  expect(journalDomainSubmission(f.scope, 'handed')).toMatchObject({
    dispatchState: 'unknown',
    recovered: true
  })
  expect(journalDomainSubmission(f.scope, 'unsent')).toMatchObject({
    dispatchState: 'rejected',
    keptAsQueuedMessageId: 'unsent'
  })
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card).toMatchObject({
    state: 'waiting',
    body: { blocks: [{ type: 'text', text: 'keep my text' }] }
  })
  expect(
    nextJournalDomainQueueCard(f.db, f.scope, {
      reopenFloor: null,
      now: 100,
      automatic: true,
      steer: false
    })
  ).toEqual({ kind: 'selected', card: null })
})

it('retains earlier recovery and a conservative reopen floor when the final mark fails', async () => {
  const f = await fixture()
  f.db
    .exec(`CREATE TRIGGER reject_open_mark BEFORE UPDATE OF queue_reopened_sequence ON journal_chat_state
    WHEN NEW.queue_reopened_sequence<>OLD.queue_reopened_sequence
    BEGIN SELECT RAISE(ABORT,'mark unavailable'); END`)
  const opened = await f.run({ kind: 'open', recover: { fence: 1 } })
  expect(opened.openRecovery?.failures).toMatchObject([
    { step: 'queue-reopen', failure: { message: 'mark unavailable' } }
  ])
  expect(journalDomainSubmission(f.scope, 'handed')?.dispatchState).toBe('unknown')
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card.state).toBe('waiting')
  const reopenFloor = opened.openRecovery!.reopenFloor
  expect(reopenFloor).not.toBeNull()
  expect(
    nextJournalDomainQueueCard(f.db, f.scope, {
      reopenFloor,
      now: 100,
      automatic: true,
      steer: false
    })
  ).toEqual({ kind: 'selected', card: null })
})

it('recovers ordinary custody and withdraws only derived tasks or the selected readable continuation receipt', async () => {
  const f = await fixture()
  for (const [id, deliveryMode] of [
    ['derived', 'steer'],
    ['queued', 'queue'],
    ['legacy', undefined]
  ] as const) {
    await f.run({
      kind: 'queue-insert',
      input: {
        messageId: id,
        body: {
          ...automaticBody(id),
          from: {
            kind: 'agent',
            senders: [],
            orchestration: { message: 'task', runId: 'run', taskId: 'task', dispatchId: 'dispatch' }
          }
        },
        ...(deliveryMode ? { deliveryMode } : {})
      }
    })
  }
  for (const messageId of ['continuation', 'unreadable', 'other-first']) {
    await f.run({ kind: 'queue-insert', input: { messageId, body: automaticBody(messageId) } })
  }
  const receipt = f.db.prepare(`INSERT INTO agent_session_command_receipts
    (operation_id,session_id,caller_key,method,fingerprint,status,result_json,rejection_json,accepted_at)
    VALUES (?,'chat',?,'agentSession.send','fp','accepted',?,NULL,100)`)
  receipt.run(
    'continuation',
    'trusted-local:restart-continuation',
    JSON.stringify({ kind: 'journal-row', epoch: 'epoch', sequence: 1 })
  )
  receipt.run('unreadable', 'trusted-local:restart-continuation', 'broken-json')
  receipt.run(
    'other-first',
    'other',
    JSON.stringify({ kind: 'journal-row', epoch: 'epoch', sequence: 1 })
  )
  receipt.run(
    'other-first',
    'trusted-local:restart-continuation',
    JSON.stringify({ kind: 'journal-row', epoch: 'epoch', sequence: 1 })
  )
  const opened = await f.run({ kind: 'open' })
  expect(opened.openRecovery?.failures).toEqual([])
  expect(readJournalDomainQueuePauses(f.db, f.scope, null)).toEqual([])
  expect(journalDomainSubmission(f.scope, 'handed')?.dispatchState).toBe('pending')
  expect(journalDomainSubmission(f.scope, 'unsent')?.dispatchState).toBe('rejected')
  for (const id of ['derived', 'continuation']) {
    expect(journalDomainQueueRow(f.db, f.scope, id)?.card.state).toBe('withdrawn')
  }
  for (const id of ['unsent', 'queued', 'legacy', 'unreadable', 'other-first']) {
    expect(journalDomainQueueRow(f.db, f.scope, id)?.card.state).toBe('waiting')
  }
})

it('keeps completed holds when derived withdrawal fails and retries withdrawal on the next open', async () => {
  const f = await fixture()
  await f.run({
    kind: 'queue-insert',
    input: { messageId: 'continuation', body: automaticBody('continuation') }
  })
  f.db
    .prepare(`INSERT INTO agent_session_command_receipts
    (operation_id,session_id,caller_key,method,fingerprint,status,result_json,rejection_json,accepted_at)
    VALUES ('continuation','chat','trusted-local:restart-continuation','agentSession.send','fp','accepted',?,NULL,100)`)
    .run(JSON.stringify({ kind: 'journal-row', epoch: 'epoch', sequence: 1 }))
  f.db.exec(`CREATE TRIGGER reject_withdraw BEFORE UPDATE OF state ON journal_queue_cards
    WHEN NEW.message_id='continuation' AND NEW.state='withdrawn'
    BEGIN SELECT RAISE(ABORT,'withdraw unavailable'); END`)
  const opened = await f.run({ kind: 'open' })
  expect(opened.openRecovery?.failures).toMatchObject([
    { step: 'withdraw-derived', failure: { message: 'withdraw unavailable' } }
  ])
  expect(journalDomainSubmission(f.scope, 'unsent')?.dispatchState).toBe('rejected')
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card.state).toBe('waiting')
  expect(journalDomainQueueRow(f.db, f.scope, 'continuation')?.card.state).toBe('waiting')
  f.db.exec('DROP TRIGGER reject_withdraw')
  expect((await f.run({ kind: 'open' })).openRecovery?.failures).toEqual([])
  expect(journalDomainQueueRow(f.db, f.scope, 'unsent')?.card.state).toBe('waiting')
  expect(journalDomainQueueRow(f.db, f.scope, 'continuation')?.card.state).toBe('withdrawn')
})

it('marks a working subagent as unverifiable when another handle opens its saved journal', async () => {
  const f = domainLifecycleFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'roster' },
    body: {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'group',
          agents: [{ id: 'a', label: 'read', state: 'working', startedAt: 10 }]
        }
      ]
    },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })
  const opened = await f.run({ kind: 'open' })
  expect(opened.value).toEqual({ epoch: 'epoch', sequence: 1 })
  expect(f.item('orca:roster')).toMatchObject({
    recovered: true,
    body: { blocks: [{ agents: [{ id: 'a', state: 'unverifiable' }] }] }
  })
  const recovered = f.item('orca:roster')!
  expect(recovered).toMatchObject({ sequence: 1, revision: 2 })
  expect(recovered.body.kind === 'message' && recovered.body.blocks[0]).toEqual({
    type: 'subagent-group',
    groupId: 'group',
    agents: [{ id: 'a', label: 'read', state: 'unverifiable', startedAt: 10 }]
  })
  f.reopen()
  await f.run({ kind: 'open' })
  expect(f.item('orca:roster')).toEqual(recovered)
})
