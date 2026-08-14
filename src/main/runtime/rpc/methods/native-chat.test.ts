import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { RpcContext } from '../core'

// Stub the bounded tail reader so the handler returns a deterministic transcript with
// one oversized tool-result block; the test then asserts clip behavior per client.
const OVERSIZED = 'x'.repeat(5000)
const cachedResult = vi.hoisted(() => ({
  value: {
    messages: [] as NativeChatMessage[],
    // Optional so truncation-gating fixtures can omit it; lifecycle tests set it explicitly.
    lifecycle: undefined as
      | { state: 'working' | 'completed' | 'interrupted'; turnId: string; timestamp: number | null }
      | undefined
  } as {
    messages: NativeChatMessage[]
    lifecycle?: {
      state: 'working' | 'completed' | 'interrupted'
      turnId: string
      timestamp: number | null
    }
  }
}))
const tailRead = vi.hoisted(() => ({ signal: undefined as AbortSignal | undefined }))
const watcher = vi.hoisted(() => ({
  args: null as null | {
    onInitialSnapshot?: (
      messages: NativeChatMessage[],
      hasMore: boolean,
      beforeOffset: number,
      error?: string,
      lifecycle?: {
        state: 'working' | 'completed' | 'interrupted'
        turnId: string
        timestamp: number | null
      }
    ) => void
    onReplace?: (
      messages: NativeChatMessage[],
      hasMore: boolean,
      beforeOffset: number,
      lifecycle?: {
        state: 'working' | 'completed' | 'interrupted'
        turnId: string
        timestamp: number | null
      }
    ) => void
    onAppend: (
      messages: NativeChatMessage[],
      lifecycle?: {
        state: 'working' | 'completed' | 'interrupted'
        turnId: string
        timestamp: number | null
      }
    ) => void
  },
  watching: true,
  setupSignal: undefined as AbortSignal | undefined,
  setupPromise: null as Promise<{ unsubscribe: () => void; watching: boolean }> | null,
  setupFactory: null as
    | ((signal?: AbortSignal) => Promise<{ unsubscribe: () => void; watching: boolean }>)
    | null,
  unsubscribe: vi.fn()
}))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: ({ limit }: { limit: number }, signal?: AbortSignal) => {
    tailRead.signal = signal
    const messages = cachedResult.value.messages
    return Promise.resolve({
      messages: messages.slice(-limit),
      hasMore: messages.length > limit,
      beforeOffset: 123,
      ...(cachedResult.value.lifecycle ? { lifecycle: cachedResult.value.lifecycle } : {})
    })
  },
  subscribeNativeChatTranscript: (
    args: NonNullable<typeof watcher.args>,
    setupSignal?: AbortSignal
  ) => {
    watcher.args = args
    watcher.setupSignal = setupSignal
    return (
      watcher.setupFactory?.(setupSignal) ??
      watcher.setupPromise ??
      Promise.resolve({ unsubscribe: watcher.unsubscribe, watching: watcher.watching })
    )
  }
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

function makeTextMessage(text: string): NativeChatMessage {
  return { ...makeMessage(''), blocks: [{ type: 'text', text }] }
}

function readSessionHandler(): (params: unknown, ctx: RpcContext) => Promise<unknown> {
  const method = NATIVE_CHAT_METHODS.find((m) => m.name === 'nativeChat.readSession')
  if (!method) {
    throw new Error('readSession method not registered')
  }
  return method.handler as (params: unknown, ctx: RpcContext) => Promise<unknown>
}

function subscribeHandler(): (
  params: unknown,
  ctx: RpcContext,
  emit: (value: unknown) => void
) => Promise<void> {
  const method = NATIVE_CHAT_METHODS.find((candidate) => candidate.name === 'nativeChat.subscribe')
  if (!method) {
    throw new Error('subscribe method not registered')
  }
  return method.handler as (
    params: unknown,
    ctx: RpcContext,
    emit: (value: unknown) => void
  ) => Promise<void>
}

function streamingContext(clientKind: RpcContext['clientKind']): RpcContext {
  return {
    runtime: {
      registerSubscriptionCleanup: vi.fn(),
      cleanupSubscription: vi.fn(),
      cleanupSubscriptionsByPrefix: vi.fn()
    } as unknown as RpcContext['runtime'],
    connectionId: 'connection-1',
    clientKind
  }
}

function ctxWith(clientKind: RpcContext['clientKind']): RpcContext {
  return { runtime: {} as RpcContext['runtime'], clientKind }
}

function firstOutput(result: unknown): string {
  const messages = (result as { messages: NativeChatMessage[] }).messages
  const block = messages[0].blocks[0] as { output: string }
  return block.output
}

function activeWatcherArgs(): NonNullable<typeof watcher.args> {
  if (!watcher.args) {
    throw new Error('native-chat transcript watcher was not subscribed')
  }
  return watcher.args
}

describe('nativeChat.readSession clientKind truncation gating', () => {
  it('passes request cancellation to transcript resolution', async () => {
    const controller = new AbortController()
    const context = { ...ctxWith('runtime'), signal: controller.signal }
    await readSessionHandler()({ agent: 'claude', sessionId: 's' }, context)

    expect(tailRead.signal).toBe(controller.signal)
  })

  it('clips oversized tool output for mobile clients', async () => {
    cachedResult.value = { messages: [makeMessage(OVERSIZED)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const output = firstOutput(result)
    expect(output).toBe(`${OVERSIZED.slice(0, 4000)}\n… (truncated)`)
  })

  // STA-3230: a paired desktop or mobile client saw long assistant replies cut
  // at the tool-preview cap with `… (truncated)` and no way to read the rest.
  it('passes a long assistant text block through unclipped for mobile clients', async () => {
    const text = 'prose '.repeat(1000)
    cachedResult.value = { messages: [makeTextMessage(text)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const block = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0] as {
      text: string
    }
    expect(block.text).toBe(text)
  })

  it('clips a pathological text block at the safety ceiling for mobile clients', async () => {
    const text = 'y'.repeat(70_000)
    cachedResult.value = { messages: [makeTextMessage(text)] }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const block = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0] as {
      text: string
    }
    expect(block.text).toBe(`${text.slice(0, 64_000)}\n… (truncated)`)
  })

  it.each(['mobile', 'runtime', undefined] as const)(
    'omits inline image bodies and oversized metadata for %s clients',
    async (clientKind) => {
      cachedResult.value = {
        messages: [
          {
            ...makeMessage('ignored'),
            blocks: [
              {
                type: 'image-ref',
                url: `data:image/png;base64,${'a'.repeat(10_000)}`,
                alt: 'Inline image'
              },
              { type: 'image-ref', url: ' \tdata:image/png;base64,abc' },
              { type: 'image-ref', url: 'https://example.com/reference.png' },
              { type: 'image-ref', path: '/'.repeat(600) }
            ]
          }
        ]
      }

      const result = await readSessionHandler()(
        { agent: 'codex', sessionId: 's' },
        ctxWith(clientKind)
      )
      const messages = (result as { messages: NativeChatMessage[] }).messages

      expect(messages[0].blocks).toEqual([
        { type: 'image-ref', alt: 'Inline image' },
        { type: 'image-ref' },
        { type: 'image-ref', url: 'https://example.com/reference.png' },
        { type: 'image-ref' }
      ])
      expect(JSON.stringify(messages).length).toBeLessThan(1_000)
    }
  )

  it('bounds raw tool-call inputs before sending them to mobile', async () => {
    cachedResult.value = {
      messages: [
        {
          ...makeMessage('ignored'),
          blocks: [
            {
              type: 'tool-call',
              name: 'Write',
              input: { file_path: 'src/a.ts', content: OVERSIZED }
            }
          ]
        }
      ]
    }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const input = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0]

    expect(JSON.stringify(input).length).toBeLessThan(OVERSIZED.length)
    expect(JSON.stringify(input)).toContain('truncated')
  })

  it('preserves AskUserQuestion option objects at the supported nesting depth', async () => {
    cachedResult.value = {
      messages: [
        {
          ...makeMessage('ignored'),
          blocks: [
            {
              type: 'tool-call',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Choice',
                    options: [
                      { label: 'Alpha', description: 'First option' },
                      { label: 'Beta', description: 'Second option' }
                    ]
                  }
                ]
              }
            }
          ]
        }
      ]
    }

    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const block = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0]

    expect(block).toMatchObject({
      type: 'tool-call',
      input: {
        questions: [
          {
            options: [
              { label: 'Alpha', description: 'First option' },
              { label: 'Beta', description: 'Second option' }
            ]
          }
        ]
      }
    })
  })

  it('bounds tool-call keys and primitive node fanout', async () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_unused, index) => [`${'k'.repeat(200)}-${index}`, index])
    )
    cachedResult.value = {
      messages: [
        {
          ...makeMessage('ignored'),
          blocks: [{ type: 'tool-call', name: 'Write', input: wide }]
        }
      ]
    }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const encoded = JSON.stringify((result as { messages: NativeChatMessage[] }).messages[0])

    expect(encoded.length).toBeLessThan(10_000)
    expect(encoded).toContain('truncated')
  })

  it('keeps sibling tool-call keys that share a 128-char prefix distinct', async () => {
    const prefix = 'p'.repeat(128)
    cachedResult.value = {
      messages: [
        {
          ...makeMessage('ignored'),
          blocks: [
            {
              type: 'tool-call',
              name: 'Write',
              input: { [`${prefix}A`]: 'first', [`${prefix}B`]: 'second' }
            }
          ]
        }
      ]
    }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('mobile')
    )
    const block = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0] as {
      input: Record<string, unknown>
    }
    const keys = Object.keys(block.input)

    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
    expect(Object.values(block.input)).toEqual(expect.arrayContaining(['first', 'second']))
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
    expect(result).toMatchObject({ hasMore: true, beforeOffset: 123 })
  })
})

describe('nativeChat.subscribe initial snapshot', () => {
  it('preserves long assistant text across mobile stream frame types', async () => {
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    const text = 'prose '.repeat(1000)
    const message = makeTextMessage(text)
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's' },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )

    const callbacks = activeWatcherArgs()
    callbacks.onInitialSnapshot?.([message], false, 123)
    callbacks.onReplace?.([message], false, 123)
    callbacks.onAppend([message])

    expect(emitted.map((frame) => (frame as { type: string }).type)).toEqual([
      'snapshot',
      'replacement',
      'appended'
    ])
    for (const frame of emitted as { messages: NativeChatMessage[] }[]) {
      expect(frame.messages[0].blocks[0]).toEqual({ type: 'text', text })
    }
  })

  it('emits one windowed snapshot with pagination state before live appends', async () => {
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's', limit: 40 },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )
    const messages = Array.from({ length: 60 }, (_unused, index) => ({
      ...makeMessage('small'),
      id: `m-${index}`
    }))

    const callbacks = activeWatcherArgs()
    callbacks.onInitialSnapshot?.(messages, true, 123)
    const live = Array.from({ length: 60 }, (_unused, index) => ({
      ...makeMessage('live'),
      id: `m-live-${index}`
    }))
    callbacks.onAppend(live)

    expect(emitted[0]).toMatchObject({
      type: 'snapshot',
      hasMore: true,
      beforeOffset: 123
    })
    const snapshotMessages = (emitted[0] as { messages: NativeChatMessage[] }).messages
    expect(snapshotMessages).toHaveLength(40)
    expect(snapshotMessages[0].id).toBe('m-20')
    expect(emitted[1]).toMatchObject({ type: 'appended' })
    expect((emitted[1] as { messages: NativeChatMessage[] }).messages).toHaveLength(60)
  })

  it('emits an explicit error snapshot when no transcript can be watched', async () => {
    watcher.watching = false
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 'missing' },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )

    expect(emitted).toEqual([
      {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        error: 'Transcript unavailable'
      }
    ])
  })

  it('forwards an initial-drain error onto the snapshot frame', async () => {
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's' },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )

    activeWatcherArgs().onInitialSnapshot?.([], false, 0, 'Transcript unavailable')

    expect(emitted).toEqual([
      {
        type: 'snapshot',
        messages: [],
        hasMore: false,
        beforeOffset: 0,
        error: 'Transcript unavailable'
      }
    ])
  })

  it('omits error from the snapshot frame on a clean initial drain', async () => {
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's' },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )

    activeWatcherArgs().onInitialSnapshot?.([makeMessage('hi')], false, 7)

    expect(emitted).toEqual([
      {
        type: 'snapshot',
        messages: [expect.objectContaining({ id: 'a-1' })],
        hasMore: false,
        beforeOffset: 7
      }
    ])
  })

  it('forwards lifecycle on snapshot, append, and replacement frames', async () => {
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's' },
      streamingContext('runtime'),
      (value) => emitted.push(value)
    )

    const completed = {
      state: 'completed' as const,
      turnId: 'turn-rpc-1',
      timestamp: 1_720_000_000_000
    }
    const callbacks = activeWatcherArgs()
    callbacks.onInitialSnapshot?.([makeMessage('snap')], false, 3, undefined, completed)
    callbacks.onAppend([], completed)
    callbacks.onReplace?.([makeMessage('repl')], false, 9, completed)

    expect(emitted).toEqual([
      {
        type: 'snapshot',
        messages: [expect.objectContaining({ id: 'a-1' })],
        hasMore: false,
        beforeOffset: 3,
        lifecycle: completed
      },
      {
        type: 'appended',
        messages: [],
        lifecycle: completed
      },
      {
        type: 'replacement',
        messages: [expect.objectContaining({ id: 'a-1' })],
        hasMore: false,
        beforeOffset: 9,
        lifecycle: completed
      }
    ])
  })

  it('cancels pending setup when the stream is cleaned up', async () => {
    const cleanups = new Map<string, () => void>()
    const context = streamingContext('mobile')
    vi.mocked(context.runtime.registerSubscriptionCleanup).mockImplementation((id, cleanup) => {
      cleanups.set(id, cleanup)
    })
    const setupControl: {
      finish?: (subscription: { unsubscribe: () => void; watching: boolean }) => void
    } = {}
    const lateUnsubscribe = vi.fn()
    watcher.setupSignal = undefined
    watcher.setupPromise = new Promise((resolve) => {
      setupControl.finish = resolve
    })
    const emitted: unknown[] = []

    try {
      const handling = subscribeHandler()(
        { agent: 'claude', sessionId: 'pending' },
        context,
        (value) => emitted.push(value)
      )
      await vi.waitFor(() => expect(watcher.setupSignal).toBeDefined())
      const setupSignal = watcher.setupSignal as unknown as AbortSignal
      const cleanup = [...cleanups.values()][0]
      expect(cleanup).toBeDefined()

      cleanup?.()
      expect(setupSignal.aborted).toBe(true)
      setupControl.finish?.({ unsubscribe: lateUnsubscribe, watching: true })
      await handling

      expect(lateUnsubscribe).toHaveBeenCalledOnce()
      expect(emitted).toEqual([{ type: 'end' }])
    } finally {
      watcher.setupPromise = null
    }
  })

  it('handles request cancellation while setup rejects', async () => {
    const cleanups = new Map<string, () => void>()
    const controller = new AbortController()
    const context = { ...streamingContext('mobile'), signal: controller.signal }
    vi.mocked(context.runtime.registerSubscriptionCleanup).mockImplementation((id, cleanup) => {
      cleanups.set(id, cleanup)
    })
    vi.mocked(context.runtime.cleanupSubscription).mockImplementation((id) => {
      cleanups.get(id)?.()
    })
    watcher.setupSignal = undefined
    watcher.setupFactory = (signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    const emitted: unknown[] = []

    try {
      const handling = subscribeHandler()(
        { agent: 'claude', sessionId: 'pending-abort' },
        context,
        (value) => emitted.push(value)
      )
      await vi.waitFor(() => expect(watcher.setupSignal).toBeDefined())
      controller.abort(new Error('request closed'))
      await handling

      expect(context.runtime.cleanupSubscription).toHaveBeenCalledOnce()
      expect(emitted).toEqual([{ type: 'end' }])
    } finally {
      watcher.setupFactory = null
    }
  })

  it('skips setup for an already-cancelled request', async () => {
    const controller = new AbortController()
    controller.abort()
    const context = { ...streamingContext('mobile'), signal: controller.signal }
    watcher.args = null
    const emitted: unknown[] = []

    await subscribeHandler()({ agent: 'claude', sessionId: 'already-closed' }, context, (value) =>
      emitted.push(value)
    )

    expect(context.runtime.registerSubscriptionCleanup).not.toHaveBeenCalled()
    expect(watcher.args).toBeNull()
    expect(emitted).toEqual([])
  })
})

describe('nativeChat.readSession lifecycle payload', () => {
  it('forwards lifecycle from the tail reader on success', async () => {
    const lifecycle = {
      state: 'interrupted' as const,
      turnId: 'turn-read-1',
      timestamp: 1_720_000_000_100
    }
    cachedResult.value = { messages: [makeMessage('done')], lifecycle }
    const result = await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('runtime')
    )
    expect(result).toMatchObject({
      hasMore: false,
      beforeOffset: 123,
      lifecycle
    })
    expect((result as { messages: NativeChatMessage[] }).messages).toHaveLength(1)
  })
})
