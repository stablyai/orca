import { afterEach, expect, it } from 'vitest'
import {
  automaticSubmissionFixture,
  automaticBody
} from './journal-automatic-submission.test-fixture'
import { lifecycleFacts } from './journal-domain-lifecycle.test-fixture'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()))

it('keeps an agent send after a completed failed turn and reports that it was not delivered', async () => {
  const f = automaticSubmissionFixture(cleanups)
  await f.run({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'failure' },
    body: { kind: 'turn', turnId: 'failed', state: 'completed', outcome: 'failure' },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })
  const result = await f.run(
    {
      kind: 'send-admission',
      input: {
        clientMessageId: 'followup',
        body: automaticBody('please continue'),
        payloadFingerprint: 'followup',
        fence: 1,
        origin: 'host'
      },
      fromPerson: false,
      fromAgent: true,
      deliveryMode: 'queue'
    },
    {
      ...lifecycleFacts,
      identity: { ...lifecycleFacts.identity, sessionId: 'chat-test' },
      send: f.selection.authority
    }
  )
  const drained = await f.claim('automatic', f.prepare())
  expect(drained.value).toEqual({ kind: 'waiting' })
  expect(result.value).toMatchObject({
    kind: 'admitted',
    value: {
      clientMessageId: 'followup',
      queued: { messageId: 'followup', state: 'waiting' },
      delivery: {
        delivered: false,
        state: 'held',
        reason: { kind: 'worker_failed', failure: 'unknown' },
        target: { sessionId: 'chat-test' },
        waiting: 1
      }
    }
  })
  expect(f.card('followup')?.body.blocks).toEqual([{ type: 'text', text: 'please continue' }])
})
