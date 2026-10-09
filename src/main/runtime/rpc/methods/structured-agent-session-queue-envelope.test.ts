import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AGENT_SESSION_QUEUE_REPLY_MAX_BYTES } from '../../../../shared/agent-session-queue-pages'
import type {
  AgentSessionQueuedMessagesPageRequest,
  AgentSessionQueuedMessageReadRequest
} from '../../../../shared/agent-session-queue-pages'
import { readQueuedMessagesPage } from '../../../native-chat/agent-session-wire/structured-agent-session-queue-page'
import { readQueuedMessageBody } from '../../../native-chat/agent-session-wire/structured-agent-session-queue-body'
import type { QueueReplyEnvelope } from '../../../native-chat/agent-session-wire/agent-session-queue-reply-budget'
import {
  PAGE_SESSION,
  PAGE_GATE,
  pageMessage,
  queuePageRig,
  type QueuePageRig
} from '../../../native-chat/agent-session-wire/agent-session-queue-pages.test-fixture'
import {
  clearStructuredHostStub,
  dispatcher,
  hostCalls,
  installStructuredHostStub,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

let rig: QueuePageRig
beforeEach(async () => {
  rig = await queuePageRig()
  installStructuredHostStub()
  hostCalls.queuedMessagesPage = vi.fn(
    (request: AgentSessionQueuedMessagesPageRequest, envelope: QueueReplyEnvelope) =>
      readQueuedMessagesPage(rig.journal, PAGE_GATE, request, envelope)
  )
  hostCalls.queuedMessageRead = vi.fn(
    (request: AgentSessionQueuedMessageReadRequest, envelope: QueueReplyEnvelope) =>
      readQueuedMessageBody(rig.journal, PAGE_GATE, request, envelope)
  )
})
afterEach(async () => {
  clearStructuredHostStub()
  await rig.close()
})

it.each(['unary', 'streaming'] as const)(
  'measures the actual %s dispatcher envelope on local and paired/mobile paths',
  async (transport) => {
    const text = '\u0000"\\🦦'.repeat(70000)
    rig.seed(240, pageMessage('preview'.repeat(100)))
    await rig.insert('large', pageMessage(text))
    const rpc = dispatcher()
    for (const [method, params] of [
      ['agentSession.queuedMessagesPage', { sessionId: PAGE_SESSION, size: 200 }],
      ['agentSession.queuedMessageRead', { sessionId: PAGE_SESSION, messageId: 'large' }]
    ] as const) {
      const request = { id: '\u0000'.repeat(10000), authToken: 'test', method, params }
      if (transport === 'unary') {
        const reply = await rpc.dispatch(request)
        expect(reply.ok).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThanOrEqual(
          AGENT_SESSION_QUEUE_REPLY_MAX_BYTES
        )
      } else {
        const replies: string[] = []
        await rpc.dispatchStreaming(request, (reply) => replies.push(reply), STRUCTURED_CLIENT)
        expect(replies).toHaveLength(1)
        expect(JSON.parse(replies[0] ?? '').ok).toBe(true)
        expect(Buffer.byteLength(replies[0] ?? '')).toBeLessThanOrEqual(
          AGENT_SESSION_QUEUE_REPLY_MAX_BYTES
        )
      }
    }
  }
)
