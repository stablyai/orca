import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { NativeChatMessage } from '../../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from '../../native-chat/transcript-watch-contract'
import type { OrcaRuntimeService } from '../orca-runtime'
import { defineMethod, defineStreamingMethod, type RpcContext, type RpcRequest } from './core'
import { RpcDispatcher } from './dispatcher'
import {
  RPC_REPLY_TOO_LARGE_CODE,
  RPC_REPLY_TOO_LARGE_MESSAGE
} from './dispatcher-reply-size-guard'
import { isMobileE2EETextPayloadWithinLimit } from './mobile-e2ee-outbound-admission'
import { createSubscriptionRegistryDouble } from './subscription-registry-test-double'

type Watch = { args: SubscribeNativeChatTranscriptArgs; unsubscribe: Mock<() => void> }
const state = vi.hoisted((): { watches: Watch[]; track: Mock } => ({ watches: [], track: vi.fn() }))
vi.mock('../../telemetry/client', () => ({ track: state.track }))
vi.mock('../../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))
vi.mock('../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: async () => ({ messages: [], hasMore: false, beforeOffset: 0 }),
  subscribeNativeChatTranscript: async (args: SubscribeNativeChatTranscriptArgs) => {
    const watch: Watch = { args, unsubscribe: vi.fn<() => void>() }
    state.watches.push(watch)
    return { watching: true, unsubscribe: watch.unsubscribe }
  }
}))
const { NATIVE_CHAT_METHODS } = await import('./methods/native-chat')

afterEach(() => {
  state.watches.length = 0
  state.track.mockReset()
})

// Over the remote socket's 4 MiB JSON cap on its own.
const HUGE = 'x'.repeat(4.5 * 1024 * 1024)

type Reply = { id: string; ok: boolean; result?: unknown; error?: { code: string } }

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

function request(id: string, method: string, params?: unknown): RpcRequest {
  return { id, authToken: 'token', method, params }
}

function createDispatcher(methods: ConstructorParameters<typeof RpcDispatcher>[0]['methods']) {
  const registry = createSubscriptionRegistryDouble()
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these methods reach only the subscription registry and runtime id.
    runtime: { ...registry, getRuntimeId: () => 'runtime-1' } as unknown as OrcaRuntimeService,
    methods
  })
  return { dispatcher, registry }
}

function collect() {
  const raw: string[] = []
  return {
    raw,
    reply: (response: string) => raw.push(response),
    parsed: (): Reply[] => raw.map((response) => JSON.parse(response))
  }
}

function remote(clientKind: RpcContext['clientKind'], connectionId = 'socket-1') {
  return { clientKind, connectionId, replyFitsTransport: isMobileE2EETextPayloadWithinLimit }
}

function expectTooLarge(reply: Reply | undefined, id: string): void {
  expect(reply).toMatchObject({
    id,
    ok: false,
    error: { code: RPC_REPLY_TOO_LARGE_CODE, message: RPC_REPLY_TOO_LARGE_MESSAGE }
  })
}

describe('dispatcher reply size guard', () => {
  const bigUnary = defineMethod({ name: 'test.big', params: null, handler: () => HUGE })

  it.each(['mobile', 'runtime'] as const)(
    'fails an oversized unary reply to a %s client with one correlated error',
    async (clientKind) => {
      const { dispatcher } = createDispatcher([bigUnary])
      const replies = collect()

      await dispatcher.dispatchStreaming(
        request('big-1', 'test.big'),
        replies.reply,
        remote(clientKind)
      )

      expect(replies.raw).toHaveLength(1)
      expectTooLarge(replies.parsed()[0], 'big-1')
      expect(replies.raw.every(isMobileE2EETextPayloadWithinLimit)).toBe(true)
      expect(state.track).toHaveBeenCalledWith('remote_outbound_budget_close', {
        emitter: 'reply-size'
      })
    }
  )

  it('leaves replies uncapped for a caller without a transport limit', async () => {
    const { dispatcher } = createDispatcher([bigUnary])
    const replies = collect()

    await dispatcher.dispatchStreaming(request('big-1', 'test.big'), replies.reply, {
      clientKind: 'runtime'
    })

    expect(replies.parsed()).toEqual([expect.objectContaining({ ok: true, result: HUGE })])
    expect(state.track).not.toHaveBeenCalled()
  })

  it('drops every later reply of an overflowed stream and aborts its signal', async () => {
    let signal: AbortSignal | undefined
    const { dispatcher } = createDispatcher([
      defineStreamingMethod({
        name: 'test.stream',
        params: null,
        handler: async (_params, ctx, emit) => {
          signal = ctx.signal
          emit({ type: 'small' })
          emit({ type: 'big', text: HUGE })
          emit({ type: 'after' })
          throw new Error('late failure')
        }
      })
    ])
    const replies = collect()

    await dispatcher.dispatchStreaming(
      request('stream-1', 'test.stream'),
      replies.reply,
      remote('mobile')
    )

    const parsed = replies.parsed()
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'stream-1', ok: true, result: { type: 'small' } })
    expectTooLarge(parsed[1], 'stream-1')
    expect(signal?.aborted).toBe(true)
  })

  it('still aborts the handler when the connection closes', async () => {
    const connection = new AbortController()
    let signal: AbortSignal | undefined
    const { dispatcher } = createDispatcher([
      defineStreamingMethod({
        name: 'test.stream',
        params: null,
        handler: async (_params, ctx) => {
          signal = ctx.signal
        }
      })
    ])

    await dispatcher.dispatchStreaming(request('stream-1', 'test.stream'), () => {}, {
      ...remote('mobile'),
      signal: connection.signal
    })
    expect(signal?.aborted).toBe(false)
    connection.abort()

    expect(signal?.aborted).toBe(true)
  })

  it('releases an overflowed native-chat watcher and keeps the other stream on the socket live', async () => {
    const { dispatcher, registry } = createDispatcher(NATIVE_CHAT_METHODS)
    const big = collect()
    const other = collect()
    const subscribe = (id: string, sessionId: string, reply: (response: string) => void) =>
      dispatcher.dispatchStreaming(
        request(id, 'nativeChat.subscribe', {
          agent: 'claude',
          sessionId,
          subscriptionId: `${sessionId}-token`
        }),
        reply,
        remote('mobile')
      )
    await subscribe('big-stream', 'big', big.reply)
    await subscribe('other-stream', 'other', other.reply)
    const [bigWatch, otherWatch] = state.watches

    bigWatch?.args.onInitialSnapshot?.([message('m-1')], false, 0, HUGE)
    bigWatch?.args.onAppend([message('m-2')])
    otherWatch?.args.onAppend([message('live')])

    expect(big.raw).toHaveLength(1)
    expectTooLarge(big.parsed()[0], 'big-stream')
    expect(bigWatch?.unsubscribe).toHaveBeenCalledTimes(1)
    await vi.waitFor(() =>
      expect(registry.peekCleanup('nativeChat:socket-1:big-token')).toBeUndefined()
    )
    expect(otherWatch?.unsubscribe).not.toHaveBeenCalled()
    expect(other.parsed()).toEqual([
      expect.objectContaining({
        id: 'other-stream',
        ok: true,
        result: { type: 'appended', messages: [message('live')] }
      })
    ])
  })
})
