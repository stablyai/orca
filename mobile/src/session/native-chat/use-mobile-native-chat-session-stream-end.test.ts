import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import type { RpcClient } from '../../transport/rpc-client'
import { MobileRelayRpcStreams } from '../../transport/mobile-relay-rpc-streams'
import { RpcClientStreamRegistry } from '../../transport/rpc-client-stream-registry'
import type { RpcResponse } from '../../transport/types'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript'
  }
}

function streamed(id: string, result: unknown): RpcResponse {
  return { id, ok: true, streaming: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type SentRequest = { id: string; method: string; params?: unknown }

function readSentRequest(value: unknown): SentRequest {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('id' in value) ||
    !('method' in value) ||
    typeof value.id !== 'string' ||
    typeof value.method !== 'string'
  ) {
    throw new Error('unexpected request shape')
  }
  return {
    id: value.id,
    method: value.method,
    params: 'params' in value ? value.params : undefined
  }
}

function testClient(subscribe: RpcClient['subscribe']): RpcClient {
  return {
    sendRequest: () => new Promise<RpcResponse>(() => {}),
    subscribe,
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
}

function listenerClient(): {
  client: RpcClient
  subscribe: ReturnType<typeof vi.fn<RpcClient['subscribe']>>
  listeners: ((frame: unknown) => void)[]
} {
  const listeners: ((frame: unknown) => void)[] = []
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, _params, onData) => {
    listeners.push(onData)
    return () => {}
  })
  return { client: testClient(subscribe), subscribe, listeners }
}

// Model host token ownership: subscribe replaces same-token feeds, unsubscribe ends the current owner, and end frames arrive on later delivery.

type TransportRig = {
  client: RpcClient
  sent: SentRequest[]
  reply: (response: RpcResponse) => void
  reconnect?: () => void
}

function directRig(): TransportRig {
  const sent: SentRequest[] = []
  let nextId = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++nextId}`,
    getState: () => 'connected',
    sendFrame: (request) => {
      sent.push(readSentRequest(request))
      return true
    }
  })
  return {
    client: testClient(registry.subscribe.bind(registry)),
    sent,
    reply: (response) => registry.handleResponse(response),
    reconnect: () => {
      registry.markForReplay()
      registry.replayAfterAuthentication()
    }
  }
}

function relayRig(): TransportRig {
  const sent: SentRequest[] = []
  let nextId = 0
  const streams = new MobileRelayRpcStreams({
    nextId: () => `relay-${++nextId}`,
    sendFrame: (request) => {
      sent.push(request)
      return true
    },
    waitForConnected: async () => {}
  })
  return {
    client: testClient(streams.subscribe.bind(streams)),
    sent,
    reply: (response) => streams.handleResponse(response)
  }
}

describe('useMobileNativeChatSession host-ended stream', () => {
  let renderer: ReactTestRenderer | null = null
  let state: MobileNativeChatSession | null = null

  beforeEach(() => {
    state = null
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Harness({
    client,
    agent = 'claude',
    sessionId = 'session'
  }: {
    client: RpcClient
    agent?: string | null
    sessionId?: string
  }): null {
    state = useMobileNativeChatSession({
      client,
      sourceIdentity: 'host-a\0workspace-a',
      agent,
      sessionId,
      transcriptPath: null
    })
    return null
  }

  async function render(props: {
    client: RpcClient
    agent?: string | null
    sessionId?: string
  }): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Harness, props))
      } else {
        renderer = create(createElement(Harness, props))
      }
    })
  }

  function sentWith(rig: TransportRig, method: string): SentRequest[] {
    return rig.sent.filter((request) => request.method === method)
  }

  function tokenOf(request: SentRequest): unknown {
    const params = request.params
    return typeof params === 'object' && params !== null && 'subscriptionId' in params
      ? params.subscriptionId
      : undefined
  }

  it.each([
    ['direct', directRig],
    ['relay', relayRig]
  ])(
    'leaving and re-entering an ended %s chat resubscribes with a fresh token',
    async (_label, makeRig) => {
      const rig = makeRig()
      await render({ client: rig.client })
      const [first] = sentWith(rig, 'nativeChat.subscribe')
      await act(async () => {
        rig.reply(streamed(first!.id, { type: 'end' }))
      })
      expect(state?.status).toBe('error')

      await render({ client: rig.client, agent: null })
      await render({ client: rig.client })
      const subscribes = sentWith(rig, 'nativeChat.subscribe')
      expect(subscribes).toHaveLength(2)
      expect(tokenOf(subscribes[1]!)).toMatch(/^claude:session:./)
      expect(tokenOf(subscribes[1]!)).not.toBe(tokenOf(first!))
      expect(sentWith(rig, 'nativeChat.unsubscribe')).toEqual([])
      expect(state?.status).toBe('loading')

      await act(async () => {
        rig.reply(
          streamed(subscribes[1]!.id, {
            type: 'snapshot',
            messages: [message('a'), message('b')],
            hasMore: false
          })
        )
      })
      expect(state?.status).toBe('ready')
      expect(state?.messages.map((entry) => entry.id)).toEqual(['a', 'b'])
    }
  )

  it('ignores an end on a stream it already closed itself', async () => {
    const { client, subscribe, listeners } = listenerClient()
    await render({ client })
    await render({ client, sessionId: 'other' })
    expect(subscribe).toHaveBeenCalledTimes(2)
    await act(async () =>
      listeners[1]!({ type: 'snapshot', messages: [message('a')], hasMore: false })
    )

    await act(async () => listeners[0]!({ type: 'end' }))

    expect(state?.status).toBe('ready')
    expect(subscribe).toHaveBeenCalledTimes(2)
  })
})
