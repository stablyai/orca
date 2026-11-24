import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER
} from './structured-agent-session-queued-message-rig.test-fixture'

import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import type { QueuedMessageTestRig } from './structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data.test-fixture'
import type { AgentSessionQueuedMessageMoveAnchor } from '../../../../../shared/agent-session/requests/agent-session-queued-message-wire'

let rig: QueuedMessageTestRig
beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})
afterEach(() => rig.dispose())
async function queue(text: string, mail = false) {
  const result = await rig.send(
    text,
    'queue-if-active',
    mail
      ? {
          internal: true,
          from: { kind: 'agent', senders: [], orchestration: null }
        }
      : undefined
  ).result
  if (!result.ok || !('queued' in result.value)) {
    throw new Error('not queued')
  }
  return result.value.queued.messageId
}
function move(
  messageId: string,
  anchor: AgentSessionQueuedMessageMoveAnchor,
  id = hostTestOperationId()
) {
  const fields = { messageId, ...anchor }
  return rig.host.queuedMessageMove(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.queuedMessageMove', id),
    ...fields
  })
}
it('reorders and edits durable image cards without changing attachments or captured options', async () => {
  const working = await rig.workingSend()
  const first = await queue('first')
  const body = hostTestMessage('with image')
  body.blocks.push({ type: 'image-ref', path: '/tmp/queued.png' })
  const choices = { model: 'model-a', effort: 'high', fastMode: 'true', serviceTier: 'priority' }
  const fields = { body, delivery: 'queue-if-active' as const, options: choices }
  const sent = await rig.host.send(QUEUED_RIG_CALLER, {
    envelope: rig.envelope(fields, 'agentSession.send', hostTestOperationId()),
    ...fields
  })
  if (!sent.ok || !('queued' in sent.value)) {
    throw new Error('expected queued image')
  }
  const image = sent.value.queued.messageId
  const last = await queue('last')
  expect(await move(image, { beforeMessageId: first })).toMatchObject({
    ok: true,
    value: { messageId: image, status: 'moved' }
  })
  expect((await rig.drafts()).map((card) => card.messageId)).toEqual([image, first, last])
  const journal = rig.host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)?.journal
  const card = await journal?.queuedMessages.get(image)
  if (!card) {
    throw new Error('expected image card')
  }
  const edit = {
    messageId: image,
    expectedBodyFingerprint: card.fingerprint,
    text: 'edited image caption'
  }
  expect(
    await rig.host.queuedMessageUpdate(QUEUED_RIG_CALLER, {
      envelope: rig.envelope(edit, 'agentSession.queuedMessageUpdate', hostTestOperationId()),
      ...edit
    })
  ).toMatchObject({ ok: true, value: { status: 'updated' } })
  await rig.restartHostProcess()
  const history = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!history.ok) {
    throw new Error('history refused')
  }
  expect(history.page.queuedMessages?.map((entry) => entry.messageId)).toEqual([image, first, last])
  expect(history.page.queuedMessages?.[0]?.body.blocks).toEqual([
    { type: 'text', text: 'edited image caption' },
    { type: 'image-ref', path: '/tmp/queued.png' }
  ])
  await rig.deleteQueued(first)
  expect((await rig.drafts()).map((entry) => entry.messageId)).toEqual([image, last])
  await rig.settleAccepted(working, 'finished')
  expect(await rig.sendNow(image)).toMatchObject({ ok: true })
  await eventually(async () => expect((await rig.handoff(image))?.options).toMatchObject(choices))
})
