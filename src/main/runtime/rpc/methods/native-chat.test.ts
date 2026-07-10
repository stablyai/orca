import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { RpcContext } from '../core'

// Stub the shared cache so the handler returns a deterministic transcript with
// one oversized tool-result block; the test then asserts clip behavior per client.
const OVERSIZED = 'x'.repeat(5000)
const cachedResult = vi.hoisted(() => ({ value: { messages: [] as NativeChatMessage[] } }))
vi.mock('../../../native-chat/transcript-read-cache', () => ({
  readNativeChatTranscriptCached: () => Promise.resolve(cachedResult.value)
}))

import { NATIVE_CHAT_METHODS } from './native-chat'

function makeMessage(text: string): NativeChatMessage {
  return {
    id: 'a-1',
    role: 'assistant',
    timestamp: 1_717_236_000_000,
    source: 'transcript',
    blocks: [{ type: 'tool-result', output: text, isError: false }]
  }
}

function readSessionHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readSession')
  if (!method) {
    throw new Error('readSession method not registered')
  }
  return method.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

function ctxWith(clientKind: RpcContext['clientKind']): RpcContext {
  return { runtime: {} as RpcContext['runtime'], clientKind }
}

function firstOutput(result: unknown): string {
  const messages = (result as { messages: NativeChatMessage[] }).messages
  const block = messages[0].blocks[0] as { output: string }
  return block.output
}

describe('nativeChat.readSession clientKind truncation gating', () => {
  it('clips oversized tool output for mobile clients', async () => {
    cachedResult.value = { messages: [makeMessage(OVERSIZED)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const output = firstOutput(result)
    expect(output.length).toBeLessThan(OVERSIZED.length)
    expect(output).toContain('truncated')
  })

  it('passes oversized tool output through intact for runtime (web/desktop) clients', async () => {
    cachedResult.value = { messages: [makeMessage(OVERSIZED)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('runtime')
    )
    expect(firstOutput(result)).toBe(OVERSIZED)
  })

  it('defaults to no clip when clientKind is undefined (in-process callers)', async () => {
    cachedResult.value = { messages: [makeMessage(OVERSIZED)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith(undefined)
    )
    expect(firstOutput(result)).toBe(OVERSIZED)
  })

  it('clamps a limit past the max window instead of rejecting (keeps pagination unstuck)', () => {
    const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readSession')
    const parsed = method?.params?.parse({ agent: 'claude', sessionId: 's', limit: 5000 })
    // A hard reject here would fail the read and stall "load earlier" at the cap;
    // clamping returns the 2000-tail so pagination stops cleanly instead.
    expect((parsed as { limit: number }).limit).toBe(2000)
  })

  it('still rejects a non-positive limit', () => {
    const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readSession')
    expect(() => method?.params?.parse({ agent: 'claude', sessionId: 's', limit: 0 })).toThrow()
  })

  it('windows by count for all client kinds', async () => {
    const many = Array.from({ length: 60 }, (_unused, n) => {
      const message = makeMessage('small')
      return { ...message, id: `m-${n}` }
    })
    cachedResult.value = { messages: many }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's', limit: 40 },
      ctxWith('runtime')
    )
    const messages = (result as { messages: NativeChatMessage[] }).messages
    expect(messages).toHaveLength(40)
    // Tail-only: the last id survives, the first is dropped.
    expect(messages.at(-1)?.id).toBe('m-59')
    expect(messages[0].id).toBe('m-20')
  })
})
