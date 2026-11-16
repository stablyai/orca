import { afterEach, expect, it } from 'vitest'
import {
  automaticSubmissionFixture,
  automaticBody
} from './journal-automatic-submission.test-fixture'
import { lifecycleFacts } from './journal-domain-lifecycle.test-fixture'
import { readJournalDomainHeldDelivery } from './journal-domain-held-delivery'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))
const target = { sessionId: 'chat-test', epoch: 'epoch' }

function fixture() {
  const f = automaticSubmissionFixture(cleanups)
  const facts = {
    ...lifecycleFacts,
    identity: { ...lifecycleFacts.identity, sessionId: 'chat-test' },
    send: f.selection.authority
  }
  const failure = async (id: string) => {
    await f.run({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: id },
      body: { kind: 'turn', turnId: id, state: 'completed', outcome: 'failure' },
      options: { fence: 1, turnScope: { kind: 'thread' } }
    })
    await f.run({
      kind: 'item',
      identity: { provider: 'orca', clientMessageId: `${id}-report` },
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'providerUnavailable', retry: { error: 'connection_error' } },
          { surface: 'row' }
        )
      },
      options: { fence: 1, turnScope: { kind: 'turn', turnItemId: `orca:${id}` } }
    })
    return readJournalDomainHeldDelivery(f.db, target, null)!.failureId
  }
  const resume = (failureId: string, operationId: string, hasMessage?: true) =>
    f.run(
      {
        kind: 'failure-resume',
        expectedFailureId: failureId,
        operationId,
        coordinatorId: 'coordinator',
        dispatchId: 'dispatch',
        fence: 1,
        ...(hasMessage ? { hasMessage } : {})
      },
      facts
    )
  return { ...f, failure, resume }
}

it('resumes a proven network failure once across restart and preserves held backlog order', async () => {
  const f = fixture()
  await f.enqueue('older')
  await f.enqueue('instruction', { body: automaticBody('continue carefully') })
  const token = await f.failure('first')
  f.reopen()
  expect((await f.resume(token, 'resume-1')).value).toEqual({ status: 'resumed', waiting: 2 })
  expect(f.card('older')?.state).toBe('waiting')
  expect(f.card('instruction')?.body.blocks).toEqual([{ type: 'text', text: 'continue carefully' }])
  expect((await f.claim('handoff', f.prepare())).value).toMatchObject({ kind: 'claimed' })
  expect(f.card('older')?.state).toBe('dispatched')
  expect(f.card('instruction')?.state).toBe('waiting')
  f.reopen()
  expect((await f.resume(token, 'resume-2')).value).toEqual({ status: 'already-used', waiting: 1 })
})

it('refuses delayed F1 intent after owner recovery and unrelated F2 without releasing F2', async () => {
  const f = fixture()
  await f.enqueue('kept')
  const first = await f.failure('first')
  await f.run({ kind: 'queue-resume', fence: 1 })
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'owner-success' },
    body: { kind: 'turn', turnId: 'owner-success', state: 'completed', outcome: 'success' },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })
  const second = await f.failure('second')
  f.reopen()
  expect((await f.resume(first, 'delayed', true)).value).toEqual({
    status: 'stale-failure',
    waiting: 1
  })
  expect(f.card('must-not-land')).toBeUndefined()
  expect((await f.claim('still-held', f.prepare())).value).toEqual({ kind: 'waiting' })
  expect((await f.resume(second, 'new-intent')).value).toEqual({ status: 'resumed', waiting: 1 })
})

it('never spends a failure recovery through a personal Stop or reopen hold', async () => {
  const f = fixture()
  await f.enqueue('kept')
  const token = await f.failure('first')
  await f.run({ kind: 'stop', fence: 1, event: { reason: 'user-stop' } })
  expect((await f.resume(token, 'blocked')).value).toEqual({ status: 'blocked', waiting: 1 })
  expect((await f.claim('still-held', f.prepare())).value).toEqual({ kind: 'waiting' })
  await f.run({ kind: 'queue-resume', fence: 1 })
  await f.failure('second')
  await f.run({ kind: 'queue-reopen', fence: 1 })
  const second = readJournalDomainHeldDelivery(f.db, target, null)!.failureId
  expect((await f.resume(second, 'reopened')).value).toEqual({ status: 'blocked', waiting: 1 })
})

it('reports individually held messages separately and leaves them held after recovery', async () => {
  const f = fixture()
  await f.enqueue('held', { holdReason: 'send_failed' })
  await f.enqueue('ready')
  const token = await f.failure('first')
  expect((await f.resume(token, 'resume-1')).value).toEqual({
    status: 'resumed',
    waiting: 2,
    stillHeld: 1,
    heldReason: 'held individually'
  })
  expect((await f.claim('handoff', f.prepare())).value).toMatchObject({ kind: 'claimed' })
  expect(f.card('ready')?.state).toBe('dispatched')
  expect(f.card('held')?.state).toBe('waiting')
})

it('requires the owner when the coordinator recovery itself fails again', async () => {
  const f = fixture()
  await f.enqueue('kept')
  const token = await f.failure('first')
  await f.resume(token, 'resume-1')
  await f.claim('recovery-attempt', f.prepare())
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'recovery-attempt',
      state: 'accepted',
      fence: 1,
      providerIdentity: null
    }
  })
  await f.enqueue('next')
  const second = await f.failure('second')
  expect((await f.resume(second, 'repeat')).value).toEqual({ status: 'already-used', waiting: 1 })
  expect((await f.claim('still-held', f.prepare())).value).toEqual({ kind: 'waiting' })
})

it('does not attribute a later unrelated failure to a recovery with no saved input', async () => {
  const f = fixture()
  const first = await f.failure('first')
  expect((await f.resume(first, 'empty')).value).toMatchObject({ status: 'resumed', waiting: 0 })
  await f.enqueue('unrelated', {
    body: {
      ...automaticBody('unrelated'),
      from: { kind: 'agent', senders: [], orchestration: null }
    }
  })
  await f.claim('unrelated-attempt', f.prepare())
  await f.run({
    kind: 'dispatch',
    input: {
      clientMessageId: 'unrelated-attempt',
      state: 'accepted',
      fence: 1,
      providerIdentity: null
    }
  })
  const second = await f.failure('second')
  expect((await f.resume(second, 'fresh')).value).toMatchObject({ status: 'resumed' })
})

it('leaves a failed worker unchanged when recovery has attached text and lets an owner Resume end the retry chain', async () => {
  const f = fixture()
  await f.enqueue('kept')
  const first = await f.failure('first')
  expect((await f.resume(first, 'attached', true)).value).toEqual({
    status: 'message-attached',
    waiting: 1
  })
  expect((await f.claim('before-resume', f.prepare())).value).toEqual({ kind: 'waiting' })
  expect((await f.resume(first, 'resume-1')).value).toEqual({ status: 'resumed', waiting: 1 })
  await f.failure('second')
  await f.run({ kind: 'queue-resume', fence: 1 })
  const third = await f.failure('third')
  expect((await f.resume(third, 'resume-2')).value).toEqual({ status: 'resumed', waiting: 1 })
})
