import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import type { RpcRequest } from '../../../src/main/runtime/rpc/core'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import {
  RPC_REPLY_TOO_LARGE_CODE,
  RPC_REPLY_TOO_LARGE_MESSAGE
} from '../../../src/main/runtime/rpc/dispatcher-reply-size-guard'
import { isMobileE2EETextPayloadWithinLimit } from '../../../src/main/runtime/rpc/mobile-e2ee-outbound-admission'
import { createSubscriptionRegistryDouble } from '../../../src/main/runtime/rpc/subscription-registry-test-double'
import type { SubscribeNativeChatTranscriptArgs } from '../../../src/main/native-chat/transcript-watch-contract'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from '../session/use-mobile-native-chat-session'
import type { RpcClient } from './rpc-client'
import { RpcClientStreamRegistry } from './rpc-client-stream-registry'
import { createStableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ConnectionState, RpcResponse } from './types'

type Watch = {
  args: SubscribeNativeChatTranscriptArgs
  unsubscribe: Mock<() => void>
}
type HostWatches = { watches: Watch[]; setups: Map<string, Promise<void>> }
const host = vi.hoisted((): HostWatches => ({ watches: [], setups: new Map() }))
vi.mock('../../../src/main/native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: async () => ({ messages: [], hasMore: false, beforeOffset: 0 }),
  subscribeNativeChatTranscript: async (args: SubscribeNativeChatTranscriptArgs) => {
    const watch: Watch = { args, unsubscribe: vi.fn<() => void>() }
    host.watches.push(watch)
    await host.setups.get(args.sessionId)
    return { watching: true, unsubscribe: watch.unsubscribe }
  }
}))
const { NATIVE_CHAT_METHODS } = await import('../../../src/main/runtime/rpc/methods/native-chat')

// Over the phone socket's 4 MiB JSON cap on its own.
const HUGE = 'x'.repeat(4.5 * 1024 * 1024)

function message(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 1,
    source: 'transcript',
    transcriptOffset: 0
  }
}

/** Lets any dispatch a replay or migration started reach the host watcher. */
async function settleHostDispatch(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

function watchesFor(sessionId: string): Watch[] {
  return host.watches.filter((watch) => watch.args.sessionId === sessionId)
}

function latestWatch(sessionId: string): Watch {
  const watch = watchesFor(sessionId).at(-1)
  if (!watch) {
    throw new Error(`No host watcher for ${sessionId}`)
  }
  return watch
}

function createHost() {
  const registry = createSubscriptionRegistryDouble()
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat and the streaming dispatcher reach only the subscription registry and runtime id.
    runtime: { ...registry, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
    methods: NATIVE_CHAT_METHODS
  })
  return { dispatcher, registry }
}

/** One physical phone socket: the real stream registry wired to the real host dispatcher. */
class HostBoundSession implements RpcClient {
  readonly registry: RpcClientStreamRegistry
  private socketEpoch = 0
  private nextId = 0
  private readonly stateListeners = new Set<(state: ConnectionState) => void>()

  constructor(
    private readonly hostSide: ReturnType<typeof createHost>,
    private readonly name: string
  ) {
    this.registry = new RpcClientStreamRegistry({
      nextId: () => `${name}-${++this.nextId}`,
      deviceToken: 'device',
      getState: () => 'connected',
      sendEncrypted: (request) => {
        const epoch = this.socketEpoch
        const connectionId = `${name}:${epoch}`
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry sends {id, deviceToken, method, params}; dispatch reads only id, method and params.
        const frame = request as RpcRequest
        void this.hostSide.dispatcher.dispatchStreaming(
          frame,
          (reply) => {
            // A reply written to a closed socket never reaches the phone.
            if (this.socketEpoch === epoch) {
              const response: RpcResponse = JSON.parse(reply)
              this.registry.handleResponse(response)
            }
          },
          {
            clientKind: 'mobile',
            connectionId,
            replyFitsTransport: isMobileE2EETextPayloadWithinLimit
          }
        )
        return true
      }
    })
  }

  /** The socket drops and re-authenticates in place; the host reaps the old connection. */
  reconnect(): void {
    const closed = `${this.name}:${this.socketEpoch}`
    this.socketEpoch += 1
    this.registry.markForReplay()
    this.hostSide.registry.cleanupSubscriptionsForConnection(closed)
    this.registry.replayAfterAuthentication()
  }

  subscribe: RpcClient['subscribe'] = (method, params, listener, options) =>
    this.registry.subscribe(method, params, listener, options)
  sendRequest = vi.fn<RpcClient['sendRequest']>()
  updateTerminalSubscriptionViewport = vi.fn()
  notifyForeground = vi.fn()
  close = vi.fn(() => {
    this.socketEpoch += 1
  })
  getState = (): ConnectionState => 'connected'
  getReconnectAttempt = (): number => 0
  getLastConnectedAt = (): number | null => null
  onStateChange = (listener: (state: ConnectionState) => void): (() => void) => {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }
}

let renderer: ReactTestRenderer | null = null
let chat: MobileNativeChatSession | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  chat = null
  host.watches.length = 0
  host.setups.clear()
})

function Harness({ client }: { client: RpcClient }): null {
  chat = useMobileNativeChatSession({
    client,
    sourceIdentity: 'host\0workspace',
    agent: 'claude',
    sessionId: 'big',
    transcriptPath: null
  })
  return null
}

async function mountChat(client: RpcClient): Promise<void> {
  await act(async () => {
    renderer = create(createElement(Harness, { client }))
  })
  await vi.waitFor(() => expect(watchesFor('big')).toHaveLength(1))
}

describe('an oversized native-chat reply fails only its own stream', () => {
  it('retires the stream on the phone, surfaces one failure, keeps other streams and does not replay it', async () => {
    const hostSide = createHost()
    const socket = new HostBoundSession(hostSide, 'direct')
    const client = createStableLogicalRpcClient(socket, 'lan')
    await mountChat(client)
    const other: unknown[] = []
    client.subscribe(
      'nativeChat.subscribe',
      { agent: 'claude', sessionId: 'other', subscriptionId: 'other-token' },
      (frame) => other.push(frame)
    )
    await vi.waitFor(() => expect(watchesFor('other')).toHaveLength(1))

    await act(async () => {
      latestWatch('big').args.onInitialSnapshot?.([message('m-1')], false, 0, HUGE)
    })

    expect(chat?.status).toBe('error')
    expect(chat?.error).toBe(RPC_REPLY_TOO_LARGE_MESSAGE)
    expect(latestWatch('big').unsubscribe).toHaveBeenCalledTimes(1)
    expect(socket.registry.size()).toBe(1)

    latestWatch('other').args.onAppend([message('live')])
    await vi.waitFor(() =>
      expect(other).toEqual([{ type: 'appended', messages: [message('live')] }])
    )

    socket.reconnect()
    await vi.waitFor(() => expect(watchesFor('other')).toHaveLength(2))
    expect(watchesFor('big')).toHaveLength(1)
    expect(chat?.error).toBe(RPC_REPLY_TOO_LARGE_MESSAGE)
  })

  it('retires a stream whose overflow lands while host setup is still pending', async () => {
    const setup = Promise.withResolvers<void>()
    host.setups.set('pending', setup.promise)
    const hostSide = createHost()
    const socket = new HostBoundSession(hostSide, 'direct')
    const frames: unknown[] = []
    socket.registry.subscribe(
      'nativeChat.subscribe',
      { agent: 'claude', sessionId: 'pending', subscriptionId: 'pending-token' },
      (frame) => frames.push(frame)
    )
    await vi.waitFor(() => expect(watchesFor('pending')).toHaveLength(1))

    latestWatch('pending').args.onInitialSnapshot?.([], false, 0, HUGE)
    setup.resolve()

    await vi.waitFor(() => expect(latestWatch('pending').unsubscribe).toHaveBeenCalledTimes(1))
    expect(frames).toEqual([
      {
        type: 'error',
        message: RPC_REPLY_TOO_LARGE_MESSAGE,
        error: { code: RPC_REPLY_TOO_LARGE_CODE, message: RPC_REPLY_TOO_LARGE_MESSAGE }
      }
    ])
    expect(socket.registry.size()).toBe(0)
    socket.reconnect()
    await settleHostDispatch()
    expect(watchesFor('pending')).toHaveLength(1)
  })

  it('reattaches the retained logical subscription once per real migration, and never after dispose', async () => {
    const hostSide = createHost()
    const direct = new HostBoundSession(hostSide, 'direct')
    const client = createStableLogicalRpcClient(direct, 'lan')
    await mountChat(client)
    await act(async () => {
      latestWatch('big').args.onInitialSnapshot?.([message('m-1')], false, 0, HUGE)
    })
    direct.reconnect()
    await settleHostDispatch()
    expect(watchesFor('big')).toHaveLength(1)

    await client.migrateTo(new HostBoundSession(hostSide, 'relay'), 'relay')
    await vi.waitFor(() => expect(watchesFor('big')).toHaveLength(2))
    await client.migrateTo(new HostBoundSession(hostSide, 'direct-2'), 'lan')
    await vi.waitFor(() => expect(watchesFor('big')).toHaveLength(3))

    act(() => renderer?.unmount())
    renderer = null
    await client.migrateTo(new HostBoundSession(hostSide, 'relay-2'), 'relay')
    await settleHostDispatch()
    expect(watchesFor('big')).toHaveLength(3)
  })
})
