import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch-contract'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeSubscriptionRegistry } from '../../runtime-subscription-registry'
import type { RpcContext } from '../core'

const sourceHooks = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: vi.fn(),
  subscribeNativeChatTranscript: (...args: unknown[]) => {
    sourceHooks.subscribe(...args)
    return Promise.resolve({ unsubscribe: () => {}, watching: true })
  }
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

type Handler = (
  params: unknown,
  ctx: RpcContext,
  emit: (value: unknown) => void
) => Promise<unknown>

function handler(name: string): Handler {
  const method = NATIVE_CHAT_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`${name} not registered`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both methods take (params, ctx[, emit]); the test only calls them with that shape.
  return method.handler as Handler
}

/** One phone connection on a runtime whose subscriptions live in the real registry. */
function phoneConnection(): {
  context: RpcContext
  subscribe: (subscriptionId: string) => Promise<unknown[]>
  unsubscribe: (subscriptionId: string) => Promise<void>
} {
  const registry = new RuntimeSubscriptionRegistry()
  const context: RpcContext = {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only touch these registry-backed members and the hook rows.
    runtime: {
      getAgentProviderSessionRows: () => [],
      registerSubscriptionCleanup: registry.register.bind(registry),
      cleanupSubscription: registry.cleanup.bind(registry),
      cleanupSubscriptionsByPrefix: registry.cleanupByPrefix.bind(registry)
    } as unknown as RpcContext['runtime'],
    connectionId: 'phone-connection',
    clientKind: 'mobile'
  }
  return {
    context,
    subscribe: async (subscriptionId) => {
      const emitted: unknown[] = []
      await handler('nativeChat.subscribe')(
        { agent: 'claude', sessionId: 'session', subscriptionId },
        context,
        (value) => emitted.push(value)
      )
      return emitted
    },
    unsubscribe: async (subscriptionId) => {
      await handler('nativeChat.unsubscribe')({ subscriptionId }, context, () => {})
    }
  }
}

describe('nativeChat subscription tokens on one connection', () => {
  it('keeps two feeds of the same chat apart when each has its own token', async () => {
    const phone = phoneConnection()
    const under = await phone.subscribe('claude:session:under')
    const top = await phone.subscribe('claude:session:top')
    expect(under).toEqual([])
    expect(top).toEqual([])

    await phone.unsubscribe('claude:session:top')
    expect(top).toEqual([{ type: 'end' }])
    expect(under).toEqual([])
  })

  it('ends the older feed when a second one reuses its token', async () => {
    const phone = phoneConnection()
    const older = await phone.subscribe('claude:session')
    const newer = await phone.subscribe('claude:session')
    expect(older).toEqual([{ type: 'end' }])
    expect(newer).toEqual([])
  })
})

it('allows only the owning negotiated terminal subscription to read its complete current feed', async () => {
  const phone = phoneConnection()
  const contract = 'agent-session.current-requests.v2' as const
  const marker = {
    contract,
    sessionId: 'session',
    epoch: 'e',
    publisher: 'host',
    owner: 'source',
    revision: 1,
    version: 'v'
  }
  const items = {
    blocking: [],
    asyncQuestions: [],
    context: { sessionId: 'session', boundary: 'file' }
  }
  sourceHooks.subscribe.mockImplementation((args: SubscribeNativeChatTranscriptArgs) => {
    args.onCurrentRequests?.({ identity: 'host', marker, items })
  })
  try {
    await handler('nativeChat.subscribe')(
      {
        agent: 'codex',
        sessionId: 'session',
        subscriptionId: 'current',
        capabilities: { currentRequests: 2 }
      },
      { ...phone.context, clientCapabilities: [contract] },
      () => {}
    )
    const read = handler('nativeChat.currentRequests')
    const request = { sessionId: 'session', subscriptionId: 'current', version: 'v' }
    await expect(read(request, phone.context, () => {})).resolves.toMatchObject({
      json: JSON.stringify(items)
    })
    await expect(
      read(request, { ...phone.context, connectionId: 'another-phone' }, () => {})
    ).rejects.toThrow('unavailable')
    await phone.unsubscribe('current')
    await expect(read(request, phone.context, () => {})).rejects.toThrow('unavailable')
  } finally {
    sourceHooks.subscribe.mockReset()
  }
})
