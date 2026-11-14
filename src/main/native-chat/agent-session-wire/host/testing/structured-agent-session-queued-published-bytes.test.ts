import { afterEach, beforeEach, expect, it } from 'vitest'

import '../../../../../shared/rpc-contract/structured-agent-session/structured-agent-session-params'

import { QUEUED_MESSAGES_PUBLISHED_MAX_BYTES } from '../../delivery/structured-agent-session-queued-published-bytes'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

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

  expect(await rig.deleteQueued(first.value.queued.messageId)).toMatchObject({ ok: true })
  expect(await rig.send(text, 'queue-if-active').result).toMatchObject({
    ok: true,
    value: { queued: { state: 'waiting' } }
  })
})
