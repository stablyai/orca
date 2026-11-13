import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { RpcContext } from '../../core'
import { prepareNativeChatMessages } from '../../../../../shared/native-chat/transcript/native-chat-message-preparation'
import { prunePendingSends } from '../../../../../shared/native-chat/transcript/native-chat-pending-sends'

// Return a deterministic transcript with an oversized tool result to verify client-specific clipping.
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
    onTranscriptPending?: () => void
  },
  watching: true,
  setupSignal: undefined as AbortSignal | undefined,
  setupPromise: null as Promise<{ unsubscribe: () => void; watching: boolean }> | null,
  setupFactory: null as
    | ((signal?: AbortSignal) => Promise<{ unsubscribe: () => void; watching: boolean }>)
    | null,
  unsubscribe: vi.fn()
}))
vi.mock('../../../../native-chat/transcript-watch', () => ({
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
vi.mock('../../../../native-chat/transcript-tail-reader', () => ({
  readNativeChatTranscriptTail: ({ limit }: { limit: number }, signal?: AbortSignal) => {
    tailRead.signal = signal
    const messages = cachedResult.value.messages
    return Promise.resolve({
      messages: messages.slice(-limit),
      hasMore: messages.length > limit,
      beforeOffset: 123,
      ...(cachedResult.value.lifecycle ? { lifecycle: cachedResult.value.lifecycle } : {})
    })
  }
}))

import '../../../../native-chat/subagent-entry-id-bounds'
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
  const runtime = {
    getAgentProviderSessionRows: () => [],
    registerSubscriptionCleanup: vi.fn(),
    cleanupSubscription: vi.fn(),
    cleanupSubscriptionsByPrefix: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat handlers use only the hook rows and these subscription members.
  const handlerRuntime = runtime as unknown as RpcContext['runtime']
  return { runtime: handlerRuntime, connectionId: 'connection-1', clientKind }
}

function ctxWith(clientKind: RpcContext['clientKind']): RpcContext {
  const runtime = { getAgentProviderSessionRows: () => [] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readSession uses only the hook rows.
  const handlerRuntime = runtime as unknown as RpcContext['runtime']
  return { runtime: handlerRuntime, clientKind }
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
  it.each(['text', 'path'] as const)(
    'never certifies shortened source %s after relay or repeated preparation',
    async (kind) => {
      const text = kind === 'text' ? 'y'.repeat(70_000) : 'caption'
      const images = kind === 'path' ? [`/${'a'.repeat(600)}.png`] : []
      cachedResult.value = {
        messages: [
          {
            ...makeTextMessage(text),
            role: 'user',
            blocks: [
              { type: 'text', text },
              ...images.map((path) => ({ type: 'image-ref' as const, path }))
            ],
            inputContent: { provider: 'codex', textDigest: 'a'.repeat(64), images }
          }
        ]
      }
      const pending = {
        id: 'pending',
        text,
        sourceAgent: 'codex' as const,
        sentAt: 0
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered readSession contract returns pages of the fixture transcript messages.
      const result = (await readSessionHandler()(
        { agent: 'codex', sessionId: 's' },
        ctxWith('mobile')
      )) as { messages: NativeChatMessage[] }
      const once = prepareNativeChatMessages(result.messages, 'codex')
      const twice = prepareNativeChatMessages(once, 'codex')
      expect(prunePendingSends([pending], twice)).toEqual([
        kind === 'text'
          ? pending
          : {
              ...pending,
              sourceReceipt: { sessionId: '', id: 'a-1' },
              receiptMembers: ['pending'],
              receiptProof: 'legacy',
              receiptGlue: false
            }
      ])
      expect(twice[0].inputContent).toBeUndefined()
    }
  )

  it('budgets source evidence with the whole row and preserves the file cursor when paging', async () => {
    const rows = [1, 2, 3].map((order) => ({
      ...makeTextMessage('x'.repeat(800_000)),
      id: `user-${order}`,
      role: 'user' as const,
      transcriptOrder: order * 100,
      inputContent: {
        provider: 'codex' as const,
        textDigest: 'a'.repeat(64),
        images: []
      }
    }))
    cachedResult.value = { messages: rows }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered readSession contract returns pages of the fixture transcript messages.
    const result = (await readSessionHandler()(
      { agent: 'codex', sessionId: 's', capabilities: { transcriptSourceOrder: 1 } },
      ctxWith('runtime')
    )) as { messages: NativeChatMessage[] }
    expect(result).toMatchObject({ hasMore: true, beforeOffset: 200 })
    expect(result.messages.map((row) => row.id)).toEqual(['user-2', 'user-3'])

    cachedResult.value = {
      messages: [{ ...rows[0], blocks: [{ type: 'text', text: 'x'.repeat(3_000_000) }] }]
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered readSession contract returns pages of the fixture transcript messages.
    const oversized = (await readSessionHandler()(
      { agent: 'codex', sessionId: 's', capabilities: { transcriptSourceOrder: 1 } },
      ctxWith('runtime')
    )) as { messages: NativeChatMessage[] }
    expect(oversized.messages[0].role).toBe('system')
    expect(oversized.messages[0].inputContent).toBeUndefined()
    expect(JSON.stringify(oversized).length).toBeLessThan(1_000)
  })

  it('pages every large legacy-client row without exposing the internal cursor', async () => {
    const rows = [1, 2, 3].map((order) => ({
      ...makeTextMessage('x'.repeat(800_000)),
      id: `legacy-${order}`,
      transcriptOffset: order * 100
    }))
    cachedResult.value = { messages: rows }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered readSession contract returns pages of the fixture transcript messages.
    const first = (await readSessionHandler()(
      { agent: 'claude', sessionId: 's' },
      ctxWith('runtime')
    )) as { messages: NativeChatMessage[]; beforeOffset: number; hasMore: boolean }
    expect(first.messages.map((row) => row.id)).toEqual(['legacy-2', 'legacy-3'])
    expect(first).toMatchObject({ beforeOffset: 200, hasMore: true })
    expect(
      first.messages.every(
        (row) => row.transcriptOffset === undefined && row.transcriptOrder === undefined
      )
    ).toBe(true)
    cachedResult.value = { messages: rows.slice(0, 1) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registered readSession contract returns pages of the fixture transcript messages.
    const older = (await readSessionHandler()(
      { agent: 'claude', sessionId: 's', beforeOffset: first.beforeOffset },
      ctxWith('runtime')
    )) as { messages: NativeChatMessage[] }
    expect(older.messages.map((row) => row.id)).toEqual(['legacy-1'])
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

  // Preserve full assistant replies beyond the tool-preview cap; mobile has no way to read clipped text (STA-3230).
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

  // Mobile spawn rosters must not escape through uncapped fall-through.
  it('bounds a spawn-group roster before sending it to mobile', async () => {
    cachedResult.value = {
      messages: [
        {
          ...makeMessage('ignored'),
          blocks: [
            {
              type: 'subagent-group',
              groupId: 'thread-1:turn-1',
              agents: Array.from({ length: 80 }, (_unused, index) => ({
                id: `child-${index}`,
                label: index === 0 ? OVERSIZED : 'read',
                state: index === 0 ? (OVERSIZED as 'working') : ('working' as const)
              }))
            }
          ]
        }
      ]
    }

    const result = await readSessionHandler()({ agent: 'codex', sessionId: 's' }, ctxWith('mobile'))
    const block = (result as { messages: NativeChatMessage[] }).messages[0].blocks[0]
    if (block.type !== 'subagent-group') {
      throw new Error('expected a subagent-group block')
    }

    expect(block.agents).toHaveLength(64)
    expect(block.agents[0].label.length).toBeLessThan(OVERSIZED.length)
    expect(block.agents[0].state).toBe('unverifiable')
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
})

describe('nativeChat.subscribe initial snapshot', () => {
  it('settles a not-yet-flushed transcript with a pending window, then the real snapshot', async () => {
    // New sessions may not write JSONL until prompted; send an initial frame to end the client's spinner.
    watcher.watching = true
    watcher.args = null
    const emitted: unknown[] = []
    await subscribeHandler()(
      { agent: 'claude', sessionId: 's', capabilities: { transcriptPending: 1 } },
      streamingContext('mobile'),
      (value) => emitted.push(value)
    )

    const callbacks = activeWatcherArgs()
    callbacks.onTranscriptPending?.()
    expect(emitted).toEqual([{ type: 'snapshot', messages: [], hasMore: false, pending: true }])

    const message = makeTextMessage('first turn')
    callbacks.onInitialSnapshot?.([message], false, 123)
    expect(emitted).toHaveLength(2)
    expect(emitted[1]).toMatchObject({ type: 'snapshot', hasMore: false })
    expect((emitted[1] as { pending?: boolean }).pending).toBeUndefined()
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
})
