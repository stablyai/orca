import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch'
import type { RpcContext } from '../core'
import { decodeClaudeTranscriptLine } from '../../../native-chat/transcript-line-decoders-claude'

const fixture = vi.hoisted(() => ({
  messages: [] as NativeChatMessage[],
  subscriptions: [] as SubscribeNativeChatTranscriptArgs[],
  reads: [] as unknown[]
}))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: async (args: unknown) => {
    fixture.reads.push(args)
    return { messages: fixture.messages, hasMore: true, beforeOffset: 123 }
  },
  subscribeNativeChatTranscript: async (args: SubscribeNativeChatTranscriptArgs) => {
    fixture.subscriptions.push(args)
    return { watching: true, unsubscribe: vi.fn() }
  }
}))
import { NATIVE_CHAT_METHODS } from './native-chat'

function method(name: string) {
  const found = NATIVE_CHAT_METHODS.find((entry) => entry.name === name)
  if (!found?.params) {
    throw new Error(`Missing ${name}`)
  }
  return { ...found, params: found.params }
}
function context(clientKind: RpcContext['clientKind']): RpcContext {
  return {
    clientKind,
    runtime: { registerSubscriptionCleanup: vi.fn() } as unknown as RpcContext['runtime']
  }
}
const lifecycle = { state: 'completed', turnId: 'turn', timestamp: 123 } as const

beforeEach(() => {
  fixture.reads = []
  fixture.subscriptions = []
  fixture.messages = [
    { type: 'user', uuid: 'user', message: { role: 'user', content: 'Prompt' } },
    {
      type: 'system',
      uuid: 'notice',
      subtype: 'informational',
      content: 'Please run /login',
      level: 'warning'
    },
    { type: 'assistant', uuid: 'assistant', message: { role: 'assistant', content: 'Reply' } }
  ].map((record) => {
    const message = decodeClaudeTranscriptLine(JSON.stringify(record), 'fallback')
    if (!message) {
      throw new Error('Fixture must be admitted by real decoder')
    }
    return message
  })
})

describe.each(['mobile', 'runtime', undefined] as const)(
  'notice publication to %s',
  (clientKind) => {
    it.each([undefined, false, true])(
      'gates reads, paging and every stream route with capability %s',
      async (systemNotices) => {
        const params = {
          agent: 'claude',
          sessionId: 'synthetic',
          limit: 40,
          ...(systemNotices === undefined ? {} : { capabilities: { systemNotices } })
        }
        const expectedIds =
          systemNotices === true ? ['user', 'notice', 'assistant'] : ['user', 'assistant']
        const read = method('nativeChat.readSession')
        for (const beforeOffset of [undefined, 456]) {
          const result = (await read.handler(
            read.params.parse({ ...params, beforeOffset }),
            context(clientKind),
            vi.fn()
          )) as { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number }
          expect(result.messages.map((message) => message.id)).toEqual(expectedIds)
          expect(result).toMatchObject({ hasMore: true, beforeOffset: 123 })
        }
        expect(fixture.reads[1]).toMatchObject({ beforeOffset: 456 })
        const subscribe = method('nativeChat.subscribe')
        const frames: unknown[] = []
        // A reconnect creates a fresh subscription and must negotiate again.
        for (let attempt = 0; attempt < 2; attempt++) {
          await subscribe.handler(
            subscribe.params.parse(params),
            context(clientKind),
            (frame: unknown) => frames.push(frame)
          )
          const callbacks = fixture.subscriptions.at(-1)!
          callbacks.onInitialSnapshot?.(fixture.messages, true, 123, undefined, lifecycle)
          callbacks.onReplace?.(fixture.messages, true, 123, lifecycle)
          callbacks.onAppend(fixture.messages, lifecycle)
        }
        expect(frames).toHaveLength(6)
        for (const frame of frames as { messages: NativeChatMessage[]; lifecycle: unknown }[]) {
          expect(frame.messages.map((message) => message.id)).toEqual(expectedIds)
          expect(frame.lifecycle).toEqual(lifecycle)
          if (systemNotices) {
            expect(frame.messages[1]).toMatchObject({
              role: 'system',
              blocks: [{ type: 'text', text: 'Please run /login', tone: 'warning' }]
            })
          }
        }
        expect(fixture.messages[1]).toMatchObject({ id: 'notice', role: 'system' })
        expect(fixture.messages).toHaveLength(3)
      }
    )
  }
)

it.each([1, 0, 'true', null, {}, []])('rejects malformed notice capability %j', (systemNotices) => {
  for (const name of ['nativeChat.readSession', 'nativeChat.subscribe']) {
    expect(
      method(name).params.safeParse({
        agent: 'claude',
        sessionId: 's',
        capabilities: { systemNotices }
      }).success
    ).toBe(false)
  }
})

it('keeps the preexisting untoned interruption projection for legacy clients', async () => {
  fixture.messages = [
    {
      id: 'interrupt',
      role: 'system',
      timestamp: null,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Interrupted' }]
    }
  ]
  const read = method('nativeChat.readSession')
  const result = await read.handler(
    read.params.parse({ agent: 'claude', sessionId: 's' }),
    context('mobile'),
    vi.fn()
  )
  expect(result).toMatchObject({ messages: fixture.messages })
})

it('keeps the cursor and hasMore on a legacy page containing only withheld notices', async () => {
  fixture.messages = [fixture.messages[1]]
  const read = method('nativeChat.readSession')
  const result = await read.handler(
    read.params.parse({ agent: 'claude', sessionId: 's', beforeOffset: 456 }),
    context('mobile'),
    vi.fn()
  )
  expect(result).toMatchObject({ messages: [], hasMore: true, beforeOffset: 123 })
  expect(fixture.messages).toHaveLength(1)
})
