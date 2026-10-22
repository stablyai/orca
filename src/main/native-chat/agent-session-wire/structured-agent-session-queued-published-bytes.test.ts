// The queue has no card count limit; only the bytes its cards publish are bounded, because every
// card rides each opening frame a remote client reads. Past that bound a send is refused in words
// that say what to do, deleting a card makes room again, and other agents' cards always leave room
// for the person's largest message.

import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionRefusalNotice } from '../../../shared/agent-session-refusal-notice'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES,
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
} from './structured-agent-session-queued-published-bytes'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'
import { hostTestMessage } from './structured-agent-session-host-test-data'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

/** Text whose message body (or, with `blocksOnly`, whose blocks) serializes to exactly `bytes`. */
function textOfBytes(bytes: number, blocksOnly = false): string {
  const empty = hostTestMessage('')
  const overhead = Buffer.byteLength(JSON.stringify(blocksOnly ? empty.blocks : empty), 'utf8')
  return 'x'.repeat(bytes - overhead)
}

it('refuses a draft past the published-bytes bound in words that say what to do', async () => {
  await rig.workingSend()
  const text = 'x'.repeat(Math.ceil(QUEUED_MESSAGES_PUBLISHED_MAX_BYTES * 0.6))
  const first = await rig.send(text, 'queue-if-active').result
  if (!first.ok || !('queued' in first.value)) {
    throw new Error('expected the first draft queued')
  }
  const refused = await rig.send(text, 'queue-if-active').result
  if (refused.ok) {
    throw new Error('expected a refusal')
  }
  expect(refused.refusal.details).toEqual({ reason: 'queueTooLarge' })
  expect(refused.refusal.message).not.toMatch(/frame|publish/i)
  expect(agentSessionRefusalNotice(refused.refusal, 'composer-send')).toBe(
    'Too much text is waiting in the queue. Your message was not sent. Delete a queued message, or wait for one to go through, then try again.'
  )
  expect(await rig.deleteQueued(first.value.queued.messageId)).toMatchObject({ ok: true })
  expect(await rig.send(text, 'queue-if-active').result).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
})

it("leaves room for the person's largest message however much other agents queue", async () => {
  await rig.workingSend()
  const agentRoom = QUEUED_MESSAGES_PUBLISHED_MAX_BYTES - QUEUED_MESSAGES_PERSON_RESERVE_BYTES
  expect(
    await rig.send(textOfBytes(agentRoom), 'queue-if-active', { internal: true }).result
  ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
  const agentRefused = await rig.send('one more task', 'queue-if-active', { internal: true }).result
  expect(agentRefused).toMatchObject({
    ok: false,
    refusal: { details: { reason: 'queueTooLarge' } }
  })
  expect(
    await rig.send(textOfBytes(MAX_PROMPT_BYTES, true), 'queue-if-active').result
  ).toMatchObject({ ok: true, value: { queued: { state: 'waiting' } } })
})
