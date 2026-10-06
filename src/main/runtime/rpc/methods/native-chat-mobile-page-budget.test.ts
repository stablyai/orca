import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { AGENT_SESSION_HISTORY_MAX_PAGE_BYTES } from '../../../native-chat/agent-session-wire/agent-session-history-page-bounds'
import {
  nativeChatLineDecoderForAgent,
  readNativeChatTranscriptTailFile
} from '../../../native-chat/transcript-tail-reader'
import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch-contract'
import { buildRegistry, isStreamingMethod, type RpcContext } from '../core'
import { createDispatcherStreamingFeatureEmitter } from '../dispatcher-streaming-feature-emitter'
import { mobileE2EETextPayloadAdmissionBytes } from '../mobile-e2ee-outbound-admission'

const state: { path: string; watcher: SubscribeNativeChatTranscriptArgs | null } = vi.hoisted(
  () => ({ path: '', watcher: null })
)
vi.mock('../../../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))
vi.mock('../../../native-chat/transcript-watch', async () => {
  // The tail reader itself is not mocked: pages come from the real JSONL fixture.
  const { readNativeChatTranscriptTail } =
    await import('../../../native-chat/transcript-tail-reader')
  return {
    readNativeChatTranscriptTail: (args: Parameters<typeof readNativeChatTranscriptTail>[0]) =>
      readNativeChatTranscriptTail({ ...args, filePath: state.path }),
    subscribeNativeChatTranscript: async (args: SubscribeNativeChatTranscriptArgs) => {
      state.watcher = args
      return { watching: true, unsubscribe: vi.fn() }
    }
  }
})
import { NATIVE_CHAT_METHODS } from './native-chat'

const roots: string[] = []
beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'orca-native-chat-mobile-budget-'))
  roots.push(root)
  state.path = join(root, 'session.jsonl')
})
afterEach(() => {
  state.watcher = null
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const OLDER_ROWS = 12
const RECENT_ROWS = 40

/** A Claude Edit result whose resolved hunks (~1.4 MB) survive the mobile char-clip. */
function largeEditResult(id: string): string {
  const hunks = Array.from({ length: 10 }, (_, hunk) => ({
    oldStart: hunk * 400 + 1,
    oldLines: 400,
    newStart: hunk * 400 + 1,
    newLines: 400,
    lines: Array.from({ length: 400 }, (_, line) => `+${`${id}-${hunk}-${line} `.padEnd(350, 'x')}`)
  }))
  return JSON.stringify({
    type: 'user',
    uuid: id,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    toolUseResult: { filePath: '/repo/big.ts', structuredPatch: hunks }
  })
}

function smallRecord(id: string): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: id,
    message: { role: 'assistant', content: [{ type: 'text', text: `reply ${id}` }] }
  })
}

/** Three large edits inside the newest 40 rows: about 4.2 MB once sanitized for a phone. */
function writeClaudeFixture(): string[] {
  const ids: string[] = []
  const lines: string[] = []
  for (let index = 0; index < OLDER_ROWS + RECENT_ROWS; index++) {
    const id = `row-${index}`
    const recent = index - OLDER_ROWS
    ids.push(id)
    lines.push([5, 20, 35].includes(recent) ? largeEditResult(id) : smallRecord(id))
  }
  writeFileSync(state.path, `${lines.join('\n')}\n`)
  return ids
}

async function recentTail(): Promise<{
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
}> {
  return readNativeChatTranscriptTailFile(
    state.path,
    RECENT_ROWS,
    nativeChatLineDecoderForAgent('claude')!
  )
}

async function subscribe(
  clientKind: RpcContext['clientKind']
): Promise<{ replies: string[]; watcher: SubscribeNativeChatTranscriptArgs }> {
  const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.subscribe')!
  if (!isStreamingMethod(method)) {
    throw new Error('Expected a subscription')
  }
  const runtime = { registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat only uses these subscription cleanup methods; its feature emitter records no interaction.
  const ctx = { runtime: runtime as unknown as RpcContext['runtime'], clientKind }
  const replies: string[] = []
  const emitter = createDispatcherStreamingFeatureEmitter(
    ctx.runtime,
    { id: 'mobile-budget', authToken: 'fixture', method: 'nativeChat.subscribe' },
    { runtimeId: '00000000-0000-4000-8000-000000000000' },
    (reply) => replies.push(reply)
  )
  await method.handler(
    method.params?.parse({ agent: 'claude', sessionId: 'session', limit: RECENT_ROWS }),
    { ...ctx, requestId: 'mobile-budget' },
    emitter.emit
  )
  if (!state.watcher) {
    throw new Error('Expected a transcript watcher')
  }
  return { replies, watcher: state.watcher }
}

type Page = {
  type?: string
  messages: NativeChatMessage[]
  hasMore: boolean
  beforeOffset: number
  lifecycle?: unknown
}

function isPage(value: unknown): value is Page {
  return (
    typeof value === 'object' &&
    value !== null &&
    'messages' in value &&
    Array.isArray(value.messages)
  )
}

function resultOf(reply: string): Page {
  const response: { result: unknown } = JSON.parse(reply)
  if (!isPage(response.result)) {
    throw new Error('Expected a native-chat page')
  }
  return response.result
}

function expectPhonePage(reply: string): Page {
  expect(Number.isFinite(mobileE2EETextPayloadAdmissionBytes(reply))).toBe(true)
  expect(Buffer.byteLength(reply)).toBeLessThanOrEqual(AGENT_SESSION_HISTORY_MAX_PAGE_BYTES)
  return resultOf(reply)
}

async function readSession(clientKind: RpcContext['clientKind'], beforeOffset?: number) {
  const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.readSession')!
  if (isStreamingMethod(method)) {
    throw new Error('Expected a page read')
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: readSession never touches the runtime.
  const ctx = { runtime: {} as RpcContext['runtime'], clientKind, requestId: 'read' }
  const result: unknown = await method.handler(
    method.params?.parse({
      agent: 'claude',
      sessionId: 'session',
      limit: RECENT_ROWS,
      ...(beforeOffset === undefined ? {} : { beforeOffset })
    }),
    ctx
  )
  if (!isPage(result)) {
    throw new Error('Expected a native-chat page')
  }
  return result
}

describe('mobile native-chat pages for transcript agents', () => {
  it('byte-bounds a Claude snapshot and pages from the first kept row', async () => {
    writeClaudeFixture()
    const { replies, watcher } = await subscribe('mobile')
    const tail = await recentTail()

    watcher.onInitialSnapshot?.(tail.messages, tail.hasMore, tail.beforeOffset)

    const page = expectPhonePage(replies[0])
    expect(page.messages.length).toBeLessThan(RECENT_ROWS)
    expect(page.messages.length).toBeGreaterThan(0)
    expect(page.hasMore).toBe(true)
    expect(page.beforeOffset).toBe(page.messages[0].transcriptOffset)
    expect(page.messages.map((message) => message.id)).toEqual(
      tail.messages.slice(-page.messages.length).map((message) => message.id)
    )
  })

  it('byte-bounds a Claude replacement the same way', async () => {
    writeClaudeFixture()
    const { replies, watcher } = await subscribe('mobile')
    const tail = await recentTail()

    watcher.onReplace?.(tail.messages, tail.hasMore, tail.beforeOffset)

    const page = expectPhonePage(replies[0])
    expect(page.type).toBe('replacement')
    expect(page.hasMore).toBe(true)
    expect(page.beforeOffset).toBe(page.messages[0].transcriptOffset)
  })

  it('splits an oversized append into batches that each fit', async () => {
    writeClaudeFixture()
    const { replies, watcher } = await subscribe('mobile')
    const tail = await recentTail()

    watcher.onAppend(tail.messages, { state: 'completed', turnId: 'turn', timestamp: 1 })

    expect(replies.length).toBeGreaterThan(1)
    const batches = replies.map(expectPhonePage)
    expect(batches.flatMap((batch) => batch.messages.map((message) => message.id))).toEqual(
      tail.messages.map((message) => message.id)
    )
    expect(batches.map((batch) => batch.lifecycle !== undefined)).toEqual(
      batches.map((_, index) => index === batches.length - 1)
    )
  })

  it('pages readSession history by byte cursor with no gap or duplicate', async () => {
    const ids = writeClaudeFixture()
    const pages: Page[] = [await readSession('mobile')]
    expect(pages[0].hasMore).toBe(true)
    expect(pages[0].messages.length).toBeLessThan(RECENT_ROWS)
    while (pages[0].hasMore) {
      const cursor = pages[0].beforeOffset
      const older = await readSession('mobile', cursor)
      expect(older.messages.length).toBeGreaterThan(0)
      expect(older.beforeOffset).toBeLessThan(cursor)
      pages.unshift(older)
    }

    for (const page of pages) {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
        AGENT_SESSION_HISTORY_MAX_PAGE_BYTES
      )
    }
    expect(pages.length).toBeGreaterThan(2)
    expect(pages.flatMap((page) => page.messages.map((message) => message.id))).toEqual(ids)
  })

  it('leaves a mobile page under the content budget as the same 40-row window', async () => {
    const lines = Array.from({ length: OLDER_ROWS + RECENT_ROWS }, (_, index) =>
      smallRecord(`row-${index}`)
    )
    writeFileSync(state.path, `${lines.join('\n')}\n`)
    const { replies, watcher } = await subscribe('mobile')
    const tail = await recentTail()

    watcher.onInitialSnapshot?.(tail.messages, tail.hasMore, tail.beforeOffset)

    expect(resultOf(replies[0])).toEqual({
      type: 'snapshot',
      messages: tail.messages,
      hasMore: true,
      beforeOffset: tail.beforeOffset
    })
    expect(resultOf(replies[0]).messages).toHaveLength(RECENT_ROWS)
  })

  it("keeps a paired desktop client's count-windowed page unchanged", async () => {
    writeClaudeFixture()
    const { replies, watcher } = await subscribe('runtime')
    const tail = await recentTail()

    watcher.onInitialSnapshot?.(tail.messages, tail.hasMore, tail.beforeOffset)
    watcher.onAppend(tail.messages)
    const read = await readSession('runtime')

    expect(resultOf(replies[0])).toMatchObject({
      hasMore: true,
      beforeOffset: tail.beforeOffset
    })
    expect(resultOf(replies[0]).messages).toHaveLength(RECENT_ROWS)
    expect(replies).toHaveLength(2)
    expect(resultOf(replies[1]).messages).toHaveLength(RECENT_ROWS)
    expect(read.messages).toHaveLength(RECENT_ROWS)
    expect(read.beforeOffset).toBe(tail.beforeOffset)
  })
})
