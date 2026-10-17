import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { RpcClient } from '../transport/rpc-client'
import { markRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { useMobileStructuredAgentSession } from './use-mobile-structured-agent-session'
import { useMobileNativeChatAsyncReply } from './use-mobile-native-chat-async-reply'
import {
  CAPABLE,
  LEGACY,
  SESSION_ID,
  fieldsOf,
  mutationOk,
  ok,
  snapshotEvent
} from './use-mobile-structured-agent-session-queued.test-fixture'
import { structuredSendResultFixture } from './structured-agent-send-result.test-fixture'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async () => null,
    setItem: async () => {},
    removeItem: async () => {}
  }
}))
const sendRequest = vi.fn<RpcClient['sendRequest']>()
const resolved = vi.fn()
const onSendError = vi.fn()
let listener: ((value: unknown) => void) | undefined
const client: RpcClient = {
  sendRequest,
  subscribe: (_method, _params, onData) => {
    listener = onData
    return () => {}
  },
  updateTerminalSubscriptionViewport: () => {},
  getState: () => 'connected',
  getReconnectAttempt: () => 0,
  getLastConnectedAt: () => 1,
  onStateChange: () => () => {},
  notifyForeground: () => {},
  close: () => {}
}
let tree: ReactTestRenderer | undefined
let latest:
  | {
      session: ReturnType<typeof useMobileStructuredAgentSession>
      reply: ReturnType<typeof useMobileNativeChatAsyncReply>
    }
  | undefined
/** Connects the real session and reply hooks to a fake RPC client with selectable host capabilities. */
function Screen({ queueCapable }: { queueCapable: boolean }) {
  const session = useMobileStructuredAgentSession({
    client,
    sessionId: SESSION_ID,
    sourceIdentity: 'host-a\0workspace-a',
    enabled: true,
    connected: true,
    agent: 'codex',
    hostSupport: queueCapable ? CAPABLE : LEGACY,
    onSendError
  })
  latest = {
    session,
    reply: useMobileNativeChatAsyncReply(
      'host-a',
      false,
      session.sendWithOutcome,
      async () => {
        throw new Error('Structured reply must not write terminal bytes')
      },
      resolved,
      session.cancel
    )
  }
  return null
}
function current() {
  if (!latest) {
    throw new Error('Session is not mounted')
  }
  return latest
}
/** Starts an active turn through the subscription, optionally with a blocking prompt. */
async function mount(queueCapable = true, extraItems: AgentJournalRenderItem[] = []) {
  await act(async () => {
    tree = create(<Screen queueCapable={queueCapable} />)
  })
  const event = snapshotEvent({ runningTurn: true })
  if (event.type !== 'snapshot' || !listener) {
    throw new Error('Expected subscription snapshot')
  }
  event.page.items.push(...extraItems)
  await act(async () => listener?.(event))
}
function sends() {
  return sendRequest.mock.calls.filter(([method]) => method === 'agentSession.send')
}
beforeEach(() => {
  vi.clearAllMocks()
  sendRequest.mockImplementation(async (method) =>
    method === 'agentSession.send'
      ? mutationOk(structuredSendResultFixture('accepted'))
      : method === 'agentSession.options'
        ? ok({ models: [], current: {} })
        : ok({})
  )
})
afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = undefined
  latest = undefined
  listener = undefined
})

it.each([true, false])(
  'sends an async answer immediately with queue capability=%s',
  async (queueCapable) => {
    await mount(queueCapable)
    await act(async () => {
      expect(await current().reply.reply.send('Which branch?\nrelease')).toBe(true)
    })
    expect(sends()).toHaveLength(1)
    const params = fieldsOf(sends()[0]?.[1])
    expect(params).toMatchObject({
      envelope: { sessionId: SESSION_ID, expectedRuntimeFence: 3 },
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Which branch?\nrelease' }]
      }
    })
    expect(params).not.toHaveProperty('delivery')
    expect(resolved).toHaveBeenCalledTimes(1)
    await act(async () => {
      await current().session.sendWithOutcome('ordinary follow-up')
    })
    expect(fieldsOf(sends()[1]?.[1]).delivery).toBe(queueCapable ? 'queue-if-active' : undefined)
  }
)

it('retains async metadata when a message arrives over the mobile subscription', async () => {
  const questions = [{ title: 'Which branch?', options: ['main', 'release'] }]
  await mount(true, [
    {
      itemId: 'question-1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Which branch?\n1. main\n2. release', asyncQuestions: questions }
        ]
      }
    }
  ])
  expect(current().session.session.messages.flatMap((message) => message.blocks)).toContainEqual({
    type: 'text',
    text: 'Which branch?\n1. main\n2. release',
    asyncQuestions: questions
  })
})

it('rejects an async answer while a blocking question owns the input', async () => {
  await mount(true, [
    {
      itemId: 'blocking-question',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'question',
        question: 'Continue?',
        options: [{ id: 'yes', label: 'Yes' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
    }
  ])
  await act(async () => {
    expect(await current().reply.reply.send('async answer')).toBe(false)
  })
  expect(sends()).toHaveLength(0)
  expect(onSendError).toHaveBeenCalledWith(
    'Answer not sent (another prompt is open or the agent is stopping)'
  )
})

it('rejects an async answer while Stop is awaiting the host', async () => {
  const cancellation = Promise.withResolvers<Awaited<ReturnType<RpcClient['sendRequest']>>>()
  sendRequest.mockImplementation(async (method) =>
    method === 'agentSession.cancel'
      ? cancellation.promise
      : method === 'agentSession.options'
        ? ok({ models: [], current: {} })
        : ok({})
  )
  await mount()
  await act(async () => current().reply.stop())
  await act(async () => {
    expect(await current().reply.reply.send('async answer')).toBe(false)
  })
  expect(sends()).toHaveLength(0)
  await act(async () => cancellation.resolve(ok({})))
})

it('does not retry or mark a reply complete when the host acknowledgement is lost', async () => {
  sendRequest.mockImplementation(async (method) => {
    if (method === 'agentSession.send') {
      throw markRpcDeliveryUnknown(new Error('Remote connection closed'))
    }
    return method === 'agentSession.options' ? ok({ models: [], current: {} }) : ok({})
  })
  await mount()
  await act(async () => {
    expect(await current().reply.reply.send('answer')).toBe(false)
  })
  expect(sends()).toHaveLength(1)
  expect(resolved).not.toHaveBeenCalled()
})
