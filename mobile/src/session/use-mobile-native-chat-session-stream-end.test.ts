import { createElement, Fragment, type ReactElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import { MobileRelayRpcStreams } from '../transport/mobile-relay-rpc-streams'
import { RpcClientStreamRegistry } from '../transport/rpc-client-stream-registry'
import type { RpcResponse } from '../transport/types'
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

/** A client whose host is the test: every subscribe's listener is kept, in order. */
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

/** A host that, like the runtime, keys each feed by its token: a same-token subscribe ends the feed
 *  it replaces, and an unsubscribe ends whatever holds the token. Frames queue until `deliver`, so
 *  each end lands a round trip after the request that caused it. */
function evictingHost(): {
  client: RpcClient
  subscribe: ReturnType<typeof vi.fn<RpcClient['subscribe']>>
  deliver: () => Promise<void>
} {
  const live = new Map<string, (frame: unknown) => void>()
  let queued: (() => void)[] = []
  const subscribe = vi.fn<RpcClient['subscribe']>((_method, params, onData) => {
    const token =
      typeof params === 'object' && params !== null && 'subscriptionId' in params
        ? String(params.subscriptionId)
        : ''
    const replaced = live.get(token)
    live.set(token, onData)
    if (replaced) {
      queued.push(() => replaced({ type: 'end' }))
    }
    queued.push(() => onData({ type: 'snapshot', messages: [message('a')], hasMore: false }))
    return () => {
      const holder = live.get(token)
      live.delete(token)
      if (holder && holder !== onData) {
        queued.push(() => holder({ type: 'end' }))
      }
    }
  })
  const deliver = async (): Promise<void> => {
    // Bounded so a same-token fight between screens shows up as an ended feed, not a hang.
    for (let round = 0; round < 10 && queued.length > 0; round += 1) {
      const frames = queued
      queued = []
      await act(async () => {
        for (const frame of frames) {
          frame()
        }
      })
    }
  }
  return { client: testClient(subscribe), subscribe, deliver }
}

/** A paired host as the phone's real stream layer sees it: requests out, replies in. */
type TransportRig = {
  client: RpcClient
  sent: SentRequest[]
  reply: (response: RpcResponse) => void
  /** Drops and re-authenticates the socket; only the direct transport replays its streams. */
  reconnect?: () => void
}

function directRig(): TransportRig {
  const sent: SentRequest[] = []
  let nextId = 0
  const registry = new RpcClientStreamRegistry({
    nextId: () => `rpc-${++nextId}`,
    deviceToken: 'device-token',
    getState: () => 'connected',
    sendEncrypted: (request) => {
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
    'settles a chat feed the host ended on a %s connection as an error, not ready',
    async (_label, makeRig) => {
      const rig = makeRig()
      await render({ client: rig.client })
      const [first] = sentWith(rig, 'nativeChat.subscribe')
      await act(async () => {
        rig.reply(
          streamed(first!.id, { type: 'snapshot', messages: [message('a')], hasMore: false })
        )
      })
      expect(state?.status).toBe('ready')

      await act(async () => {
        rig.reply(streamed(first!.id, { type: 'end' }))
      })

      expect(state?.status).toBe('error')
      expect(state?.transcriptLoading).toBe(false)
      // The conversation stays on screen; nothing reopens behind the user's back.
      expect(state?.messages.map((entry) => entry.id)).toEqual(['a'])
      expect(sentWith(rig, 'nativeChat.subscribe')).toHaveLength(1)
    }
  )

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

      // Toggle to the terminal view and back.
      await render({ client: rig.client, agent: null })
      await render({ client: rig.client })
      const subscribes = sentWith(rig, 'nativeChat.subscribe')
      expect(subscribes).toHaveLength(2)
      expect(tokenOf(subscribes[1]!)).toMatch(/^claude:session:./)
      expect(tokenOf(subscribes[1]!)).not.toBe(tokenOf(first!))
      // The ended feed is already gone on the host, so leaving it names nothing.
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

describe('useMobileNativeChatSession feeds across stacked screens', () => {
  let renderer: ReactTestRenderer | null = null
  const states = new Map<string, MobileNativeChatSession>()

  beforeEach(() => {
    states.clear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Screen({ name, client }: { name: string; client: RpcClient }): null {
    states.set(
      name,
      useMobileNativeChatSession({
        client,
        sourceIdentity: 'host-a\0workspace-a',
        agent: 'claude',
        sessionId: 'session',
        transcriptPath: null
      })
    )
    return null
  }

  function Stack({ client, screens }: { client: RpcClient; screens: string[] }): ReactElement {
    return createElement(
      Fragment,
      null,
      ...screens.map((name) => createElement(Screen, { key: name, name, client }))
    )
  }

  async function render(client: RpcClient, screens: string[]): Promise<void> {
    await act(async () => {
      if (renderer) {
        renderer.update(createElement(Stack, { client, screens }))
      } else {
        renderer = create(createElement(Stack, { client, screens }))
      }
    })
  }

  function tokenOf(request: SentRequest | unknown[]): unknown {
    const params = Array.isArray(request) ? request[1] : request.params
    return typeof params === 'object' && params !== null && 'subscriptionId' in params
      ? params.subscriptionId
      : undefined
  }

  it('keeps both feeds live when a pushed screen opens the same chat, and after it pops', async () => {
    const host = evictingHost()
    await render(host.client, ['under'])
    await host.deliver()
    expect(states.get('under')?.status).toBe('ready')

    // Resuming from agent history pushes a second screen for the same chat.
    await render(host.client, ['under', 'top'])
    await host.deliver()
    expect(states.get('under')?.status).toBe('ready')
    expect(states.get('top')?.status).toBe('ready')
    expect(host.subscribe).toHaveBeenCalledTimes(2)
    const [under, top] = host.subscribe.mock.calls
    expect(tokenOf(under!)).not.toBe(tokenOf(top!))

    // Popping the pushed screen releases its own feed only.
    await render(host.client, ['under'])
    await host.deliver()
    expect(host.subscribe).toHaveBeenCalledTimes(2)
    expect(states.get('under')?.status).toBe('ready')
  })

  it.each([
    ['direct', directRig],
    ['relay', relayRig]
  ])(
    'names each %s chat feed by its own token on replay and unsubscribe',
    async (_label, makeRig) => {
      const rig = makeRig()
      await render(rig.client, ['under', 'top'])
      const [under, top] = rig.sent.filter((request) => request.method === 'nativeChat.subscribe')
      expect(tokenOf(under!)).toMatch(/^claude:session:/)
      expect(tokenOf(top!)).toMatch(/^claude:session:/)
      expect(tokenOf(under!)).not.toBe(tokenOf(top!))

      if (rig.reconnect) {
        rig.reconnect()
        const replayed = rig.sent
          .filter((request) => request.method === 'nativeChat.subscribe')
          .slice(2)
        expect(replayed.map((request) => [request.id, tokenOf(request)])).toEqual([
          [under!.id, tokenOf(under!)],
          [top!.id, tokenOf(top!)]
        ])
      }

      // The older screen leaves while the newer one stays: its unsubscribe must still be sent.
      await render(rig.client, ['top'])
      expect(
        rig.sent
          .filter((request) => request.method === 'nativeChat.unsubscribe')
          .map((request) => request.params)
      ).toEqual([{ subscriptionId: tokenOf(under!) }])
    }
  )
})
