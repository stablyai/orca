import { sendAgentTurn } from '../../runtime/orchestration/send-agent-turn'
import { orchestrationMailFixture } from '../../../shared/agent-session/orchestration-mail.test-fixture'
import {
  HOST_TEST_SESSION,
  hostTestOperationId,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentSessionRefusalNotice } from '../../../shared/agent-session/failures/agent-session-refusal-notice'
import { MAX_PROMPT_BYTES } from '../../../shared/rpc-contract/structured-agent-session-params'
import {
  QUEUED_MESSAGES_PERSON_RESERVE_BYTES,
  QUEUED_MESSAGES_PUBLISHED_MAX_BYTES
} from './structured-agent-session-queued-published-bytes'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig

beforeEach(async () => {
  rig = await createQueuedMessageTestRig()
})

afterEach(() => rig.dispose())

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

it('publishes the first typed report only with its canonical queue admission and never starts an extra turn on replay', async () => {
  await rig.workingSend()
  const message = orchestrationMailFixture()
  const mail = message.from.orchestration
  if (mail?.message !== 'mail-notice') {
    throw new Error('fixture')
  }
  const ref = mail.messages[0]!
  const fact = {
    mailbox: mail.mailbox,
    messageId: ref.messageId,
    runId: ref.runId,
    from: ref.from,
    report: {
      version: 1 as const,
      kind: 'command' as const,
      result: { type: 'exit' as const, code: 7 }
    }
  }
  const body = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: message.blocks,
    from: message.from
  }
  const canonical = JSON.stringify(body)
  const request = {
    kind: 'structured-session' as const,
    host: rig.host,
    sessionId: HOST_TEST_SESSION,
    callerKey: 'report-producer',
    turn: {
      body,
      displayAttachments: [fact],
      operationId: hostTestOperationId(),
      expectedRuntimeFence: rig.store.getConversation(HOST_TEST_SESSION)!.currentFence,
      delivery: 'queue' as const
    }
  }
  const before = rig.dispatch.mock.calls.length
  const first = await sendAgentTurn(request)
  expect(first).toMatchObject({ kind: 'queued' })
  const history = await rig.host.history({ sessionId: HOST_TEST_SESSION, direction: 'tail' })
  if (!history.ok) {
    throw new Error('history refused')
  }
  expect(history.page.queuedMessages).toContainEqual(
    expect.objectContaining({ body, mailDisplayReports: [expect.objectContaining(fact)] })
  )
  expect(await sendAgentTurn(request)).toEqual(first)
  expect(rig.dispatch.mock.calls.length).toBe(before)
  expect(JSON.stringify(body)).toBe(canonical)
})
