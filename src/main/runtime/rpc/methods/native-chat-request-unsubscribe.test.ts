import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatUnsubscribe } from '../../../../shared/rpc-contract/native-chat-params'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcRequest } from '../core'
import { RpcDispatcher } from '../dispatcher'

type Setup = {
  signal: AbortSignal | undefined
  unsubscribe: ReturnType<typeof vi.fn>
  finish: () => void
}

// Each transcript watch resolves only when the test says so, so setup can be held pending.
const setups = vi.hoisted((): Setup[] => [])
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: vi.fn(),
  subscribeNativeChatTranscript: (_args: unknown, signal?: AbortSignal) =>
    new Promise((resolve) => {
      const unsubscribe = vi.fn()
      setups.push({ signal, unsubscribe, finish: () => resolve({ unsubscribe, watching: true }) })
    })
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

const TOKEN = 'claude:session-1'
const subscribeParams = { agent: 'claude', sessionId: 'session-1', subscriptionId: TOKEN }

let nextRequestId = 0
const subscribeRequest = (): RpcRequest => ({
  id: `req-${++nextRequestId}`,
  authToken: 'tok',
  method: 'nativeChat.subscribe',
  params: subscribeParams
})
/** What a phone that addresses its request sends; the token stays for older hosts. */
const phoneUnsubscribeParams = (requestId: string) => ({ subscriptionId: TOKEN, requestId })
const unsubscribeRequest = (params: unknown): RpcRequest => ({
  id: `req-${++nextRequestId}`,
  authToken: 'tok',
  method: 'nativeChat.unsubscribe',
  params
})

const resultTypes = (messages: string[]): unknown[] =>
  messages.map((message) => JSON.parse(message).result?.type)

function createHost() {
  const runtime = new OrcaRuntimeService()
  const tokenCleanup = vi.spyOn(runtime, 'cleanupSubscription')
  const prefixCleanup = vi.spyOn(runtime, 'cleanupSubscriptionsByPrefix')
  const dispatcher = new RpcDispatcher({ runtime, methods: NATIVE_CHAT_METHODS })
  /** Dispatches a subscribe and resolves once it registered and started its transcript watch. */
  const open = async (connectionId?: string) => {
    const request = subscribeRequest()
    const messages: string[] = []
    const before = setups.length
    const dispatch = dispatcher.dispatchStreaming(
      request,
      (message) => messages.push(message),
      connectionId ? { connectionId } : undefined
    )
    await vi.waitFor(() => expect(setups).toHaveLength(before + 1))
    return { request, messages, dispatch, setup: setups[before]! }
  }
  const unsubscribe = async (params: unknown, connectionId?: string): Promise<unknown> => {
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      unsubscribeRequest(params),
      (reply) => replies.push(reply),
      connectionId ? { connectionId } : undefined
    )
    return JSON.parse(replies[0]!).result
  }
  return { runtime, tokenCleanup, prefixCleanup, open, unsubscribe }
}

afterEach(() => {
  setups.length = 0
})

describe('nativeChat.unsubscribe addressed by request', () => {
  it('does not let an older request end the newer stream on the same token', async () => {
    const host = createHost()
    const older = await host.open('conn-a')
    older.setup.finish()
    await older.dispatch
    const newer = await host.open('conn-a')
    newer.setup.finish()
    await newer.dispatch
    // The newer registration replaced the older one under the shared token.
    expect(resultTypes(older.messages)).toEqual(['end'])

    await host.unsubscribe(phoneUnsubscribeParams(older.request.id), 'conn-a')

    expect(resultTypes(newer.messages)).not.toContain('end')
    expect(newer.setup.unsubscribe).not.toHaveBeenCalled()
    host.runtime.cleanupSubscriptionsForConnection('conn-a')
    expect(resultTypes(newer.messages)).toEqual(['end'])
  })

  it.each([
    ['while its setup is still pending', false],
    ['after its dispatch has settled', true]
  ])('ends its own stream %s', async (_label, settled) => {
    const host = createHost()
    const stream = await host.open('conn-a')
    if (settled) {
      stream.setup.finish()
      await stream.dispatch
    }

    await host.unsubscribe(phoneUnsubscribeParams(stream.request.id), 'conn-a')
    // A watch that resolves after the release is closed rather than left running.
    stream.setup.finish()
    await stream.dispatch
    await vi.waitFor(() => expect(stream.setup.unsubscribe).toHaveBeenCalledOnce())

    expect(resultTypes(stream.messages)).toEqual(['end'])
    expect(stream.setup.signal?.aborted).toBe(true)
    expect(host.tokenCleanup).not.toHaveBeenCalled()
    expect(host.prefixCleanup).not.toHaveBeenCalled()
  })

  it.each([
    ['an unknown request', () => 'req-unknown'],
    ['the unsubscribe itself', () => `req-${nextRequestId + 1}`],
    ['a stream that registers without a request address', () => 'req-tabs']
  ])('treats %s as a no-op without touching the token or prefix path', async (_label, target) => {
    const host = createHost()
    const tabsCleanup = vi.fn()
    host.runtime.registerSubscriptionCleanup(
      'session.tabs:conn-a:wt:req-tabs',
      tabsCleanup,
      'conn-a'
    )
    const live = await host.open('conn-a')
    live.setup.finish()
    await live.dispatch

    const result = await host.unsubscribe(phoneUnsubscribeParams(target()), 'conn-a')

    expect(result).toEqual({ unsubscribed: true })
    expect(resultTypes(live.messages)).not.toContain('end')
    expect(tabsCleanup).not.toHaveBeenCalled()
    expect(host.tokenCleanup).not.toHaveBeenCalled()
    expect(host.prefixCleanup).not.toHaveBeenCalled()
    host.runtime.cleanupSubscriptionsForConnection('conn-a')
  })

  it('is a no-op on a socket without a connection id', async () => {
    const host = createHost()
    // Without a connection id the stream registers under the shared `local` key and is never indexed.
    const live = await host.open()
    live.setup.finish()
    await live.dispatch

    await host.unsubscribe(phoneUnsubscribeParams(live.request.id))

    expect(resultTypes(live.messages)).not.toContain('end')
    expect(host.tokenCleanup).not.toHaveBeenCalled()
    expect(host.prefixCleanup).not.toHaveBeenCalled()
    host.runtime.cleanupSubscription(`nativeChat:local:${TOKEN}`)
  })

  it('lets a host without the field strip it and end the token, as before', async () => {
    // The shape every earlier host validates `nativeChat.unsubscribe` with; it is not strict.
    const legacyParams = NativeChatUnsubscribe.omit({ requestId: true }).parse(
      phoneUnsubscribeParams('req-any')
    )
    expect(legacyParams).toEqual({ subscriptionId: TOKEN })

    const host = createHost()
    const live = await host.open('conn-a')
    live.setup.finish()
    await live.dispatch

    await host.unsubscribe(legacyParams, 'conn-a')

    expect(host.tokenCleanup).toHaveBeenCalledWith(`nativeChat:conn-a:${TOKEN}`)
    expect(resultTypes(live.messages)).toEqual(['end'])
  })
})
