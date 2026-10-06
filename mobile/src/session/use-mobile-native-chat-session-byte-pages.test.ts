import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { RpcClient } from '../transport/rpc-client'
import {
  useMobileNativeChatSession,
  type MobileNativeChatSession
} from './use-mobile-native-chat-session'

/** A transcript row; `offset` is its record byte offset, as new hosts stamp it. */
function row(index: number, offset: number | null = index * 100): NativeChatMessage {
  return {
    id: `row-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `row ${index}` }],
    timestamp: 1,
    source: 'transcript',
    ...(offset === null ? {} : { transcriptOffset: offset })
  }
}

function rows(from: number, to: number, withOffsets = true): NativeChatMessage[] {
  return Array.from({ length: to - from }, (_, index) =>
    row(from + index, withOffsets ? (from + index) * 100 : null)
  )
}

let renderer: ReactTestRenderer | null = null
let chat: MobileNativeChatSession | null = null
let emit: (frame: unknown) => void = () => {}

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  chat = null
})

function Harness({ client }: { client: RpcClient }): null {
  chat = useMobileNativeChatSession({
    client,
    sourceIdentity: 'host\0workspace',
    agent: 'claude',
    sessionId: 'session',
    transcriptPath: null
  })
  return null
}

async function mount(
  snapshot: { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset?: number },
  sendRequest: (...args: never[]) => unknown
): Promise<void> {
  const subscribe: RpcClient['subscribe'] = vi.fn((_method, _params, onData) => {
    emit = onData
    onData({ type: 'snapshot', ...snapshot })
    return () => {}
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reaches only subscribe and sendRequest.
  const client = { sendRequest, subscribe } as unknown as RpcClient
  await act(async () => {
    renderer = create(createElement(Harness, { client }))
  })
}

async function loadEarlier(): Promise<void> {
  await act(async () => {
    chat?.loadEarlier()
    await Promise.resolve()
  })
}

function ids(): string[] {
  return chat?.messages.map((message) => message.id) ?? []
}

describe('mobile native chat with byte-bounded history pages', () => {
  it('re-cuts the cursor at the new oldest row after a live trim and pages back with no gap', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { messages: rows(40, 61), hasMore: false, beforeOffset: 4000 }
    })
    // A byte-bounded snapshot: 40 newest rows of a longer transcript.
    await mount({ messages: rows(60, 100), hasMore: true, beforeOffset: 6000 }, sendRequest)

    await act(async () => emit({ type: 'appended', messages: [row(100)] }))
    expect(ids()[0]).toBe('row-61')
    await loadEarlier()

    expect(sendRequest).toHaveBeenCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 60,
      beforeOffset: 6100
    })
    expect(ids()).toEqual(rows(40, 101).map((message) => message.id))
    expect(chat?.hasMore).toBe(false)
  })

  it('falls back to a growing-tail read for rows without offsets and adopts its paging metadata', async () => {
    const sendRequest = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        result: { messages: rows(1, 101, false), hasMore: true, beforeOffset: 100 }
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { messages: rows(0, 1, false), hasMore: false, beforeOffset: 0 }
      })
    await mount({ messages: rows(60, 100, false), hasMore: true, beforeOffset: 6000 }, sendRequest)
    await act(async () => emit({ type: 'appended', messages: [row(100, null)] }))

    await loadEarlier()
    expect(sendRequest).toHaveBeenLastCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 100
    })
    expect(chat?.hasMore).toBe(true)
    await loadEarlier()

    expect(sendRequest).toHaveBeenLastCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 60,
      beforeOffset: 100
    })
    expect(ids()).toEqual(rows(0, 101).map((message) => message.id))
    expect(chat?.hasMore).toBe(false)
  })

  it('trusts a growing-tail reply that says no older history remains', async () => {
    const sendRequest = vi.fn().mockResolvedValue({
      ok: true,
      result: { messages: rows(0, 100, false), hasMore: false, beforeOffset: 0 }
    })
    await mount({ messages: rows(60, 100, false), hasMore: true, beforeOffset: 6000 }, sendRequest)
    await act(async () => emit({ type: 'appended', messages: [row(100, null)] }))

    await loadEarlier()

    expect(chat?.hasMore).toBe(false)
  })

  it('keeps paging through many one-row pages past the old requested-count ceiling', async () => {
    let oldest = 1000
    const sendRequest = vi.fn(async () => {
      oldest -= 1
      return {
        ok: true,
        result: { messages: [row(oldest)], hasMore: true, beforeOffset: oldest * 100 }
      }
    })
    await mount({ messages: rows(1000, 1040), hasMore: true, beforeOffset: 100_000 }, sendRequest)

    for (let page = 0; page < 40; page += 1) {
      await loadEarlier()
    }

    expect(sendRequest).toHaveBeenCalledTimes(40)
    expect(chat?.messages).toHaveLength(80)
    expect(ids()[0]).toBe('row-960')
    expect(chat?.hasMore).toBe(true)
    expect(sendRequest).toHaveBeenLastCalledWith('nativeChat.readSession', {
      agent: 'claude',
      sessionId: 'session',
      limit: 60,
      beforeOffset: 96_100
    })
  })

  it('stops at the retention ceiling counted in rows actually kept', async () => {
    let oldest = 3000
    const sendRequest = vi.fn(async (_method: string, params: unknown) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook always sends a numeric page limit.
      const { limit } = params as { limit: number }
      const page = rows(oldest - limit, oldest)
      oldest -= limit
      return { ok: true, result: { messages: page, hasMore: true, beforeOffset: oldest * 100 } }
    })
    await mount({ messages: rows(3000, 3040), hasMore: true, beforeOffset: 300_000 }, sendRequest)

    for (let page = 0; page < 40; page += 1) {
      await loadEarlier()
    }

    expect(chat?.messages).toHaveLength(2000)
    expect(chat?.hasMore).toBe(false)

    await act(async () => emit({ type: 'appended', messages: [row(5000)] }))

    expect(chat?.messages).toHaveLength(2000)
    expect(chat?.hasMore).toBe(false)
  })
})
