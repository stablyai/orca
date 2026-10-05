import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { asRecord } from '../../../ai-vault/session-scanner-values'
import { readOpenCodeNativeChatTranscriptTail } from '../../../native-chat/transcript-opencode'
import { readOpenCodeTranscriptPage } from '../../../native-chat/transcript-opencode-sqlite-query'
import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch-contract'
import { createDispatcherStreamingFeatureEmitter } from '../dispatcher-streaming-feature-emitter'
import { mobileE2EETextPayloadAdmissionBytes } from '../mobile-e2ee-outbound-admission'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../../shared/remote-runtime-memory-limits'
import { buildRegistry, isStreamingMethod, type RpcContext } from '../core'

const state: { path: string; watcher: SubscribeNativeChatTranscriptArgs | null } = vi.hoisted(
  () => ({ path: '', watcher: null })
)
vi.mock('../../../managed-data-accounts/service', () => ({ getManagedDataAccountService: vi.fn() }))
vi.mock('../../../native-chat/transcript-watch', () => ({
  readNativeChatTranscriptTail: (args: {
    sessionId: string
    limit: number
    beforeOffset?: number
  }) =>
    readOpenCodeNativeChatTranscriptTail(args, {
      resolveDbPath: async () => state.path,
      readPage: async (page) => readOpenCodeTranscriptPage(page)
    }),
  subscribeNativeChatTranscript: async (args: SubscribeNativeChatTranscriptArgs) => {
    state.watcher = args
    return { watching: true, unsubscribe: vi.fn() }
  }
}))
import { NATIVE_CHAT_METHODS } from './native-chat'
import {
  boundNativeChatRpcPageByBytes,
  nativeChatRpcAppendBatches
} from './native-chat-rpc-page-bounds'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

const roots: string[] = []
afterEach(() => {
  state.watcher = null
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function denseFixture(version: 'v1' | 'v2'): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-opencode-wire-budget-'))
  roots.push(root)
  const path = join(root, 'opencode.db')
  state.path = path
  const db = new Database(path)
  if (version === 'v2') {
    db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
      CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
        data TEXT, time_created INTEGER, time_updated INTEGER);
      INSERT INTO session_v2 VALUES ('session');`)
  } else {
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY);
      CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
      CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_updated INTEGER, data TEXT);
      INSERT INTO session VALUES ('session');`)
  }
  db.exec('BEGIN')
  const insert = (id: string, role: 'user' | 'assistant', cursor: number, content: unknown[]) => {
    if (version === 'v2') {
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        id,
        'session',
        role,
        cursor,
        JSON.stringify({ content }),
        cursor,
        cursor
      )
    } else {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        id,
        'session',
        cursor,
        cursor,
        JSON.stringify({ role })
      )
      for (const [index, part] of content.entries()) {
        db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
          `${id}:${index}`,
          id,
          'session',
          cursor,
          JSON.stringify(part)
        )
      }
    }
  }
  insert('oldest', 'user', 1, [{ type: 'text', text: 'Earlier history' }])
  for (let index = 1; index <= 1200; index++) {
    insert(String(index), 'assistant', index * 7, [
      { type: 'reasoning', text: 'Я'.repeat(900) },
      { type: 'text', text: 'Я'.repeat(900) }
    ])
  }
  insert('latest', 'user', 1201 * 7, [{ type: 'text', text: 'Я'.repeat(900) }])
  db.exec('COMMIT')
  db.close()
  return path
}

function context(clientKind: RpcContext['clientKind'] = 'mobile'): RpcContext {
  const runtime = { registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Native-chat only uses these subscription cleanup methods; its feature emitter records no interaction.
  return { runtime: runtime as unknown as RpcContext['runtime'], clientKind }
}

describe.each(['v1', 'v2'] as const)('%s byte-bounded semantic pages', (version) => {
  it.each(['mobile', 'runtime'] as const)(
    'keeps an actual serialized %s replacement within E2EE admission and pages all groups',
    async (clientKind) => {
      const dbPath = denseFixture(version)
      const page = readOpenCodeTranscriptPage({ dbPath, sessionId: 'session', limit: 2400 })!
      expect(page.items).toHaveLength(2401)
      expect(page.items.every((item) => Number.isFinite(item.message.transcriptOffset))).toBe(true)
      expect(page.items.every((item) => item.message.transcriptOffset === item.rowid)).toBe(true)
      const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.subscribe')!
      if (!isStreamingMethod(method)) {
        throw new Error('Expected a subscription')
      }
      const ctx = context(clientKind)
      const replies: string[] = []
      const request = { id: 'budget-control', authToken: 'fixture', method: 'nativeChat.subscribe' }
      const emitter = createDispatcherStreamingFeatureEmitter(
        ctx.runtime,
        request,
        { runtimeId: 'private-budget-control' },
        (reply) => replies.push(reply)
      )
      await method.handler(
        method.params?.parse({ agent: 'opencode2', sessionId: 'session', limit: 2000 }),
        ctx,
        emitter.emit
      )
      const watcher = state.watcher
      if (!watcher) {
        throw new Error('Expected a native watcher')
      }
      watcher.onReplace?.(
        page.items.map((item) => item.message),
        page.hasMore,
        page.beforeMessageRowId ?? 0
      )
      const reply = replies[0]
      const admission = mobileE2EETextPayloadAdmissionBytes(reply)
      const response = asRecord(JSON.parse(reply))
      const result = asRecord(response?.result)
      const messages = Array.isArray(result?.messages) ? result.messages : []
      const receipt = process.env.ORCA_NATIVE_CHAT_BUDGET_RECEIPT
      if (receipt && version === 'v2' && clientKind === 'mobile') {
        writeFileSync(`${receipt}.payload.json`, reply)
        writeFileSync(
          receipt,
          `${JSON.stringify(
            {
              source: process.env.ORCA_NATIVE_CHAT_BUDGET_SOURCE,
              kind: 'Controlled synthetic SQLite stress; actual production parser/RPC serializer/E2EE admission, no genuine CLI claim',
              inputMessages: page.items.length,
              outputMessages: messages.length,
              serializedBytes: Buffer.byteLength(reply),
              sha256: createHash('sha256').update(reply).digest('hex'),
              maximumBytes: REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES,
              admission: Number.isFinite(admission) ? admission : 'Infinity',
              hasMore: result?.hasMore,
              beforeOffset: result?.beforeOffset,
              first: messages[0],
              last: messages.at(-1)
            },
            null,
            2
          )}\n`
        )
      }
      expect(Number.isFinite(admission)).toBe(true)
      expect(messages.length).toBeLessThan(page.items.length)
      expect(result?.hasMore).toBe(true)
      const first = asRecord(messages[0])
      expect(result?.beforeOffset).toBe(first?.transcriptOffset)
      expect(messages.map((message) => asRecord(message)?.role).at(0)).toBe('reasoning')
      expect(messages.map((message) => asRecord(message)?.role).at(1)).toBe('assistant')
      expect(new Set(messages.map((message) => asRecord(message)?.id)).size).toBe(messages.length)
      const read = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.readSession')!
      if (isStreamingMethod(read)) {
        throw new Error('Expected a page read')
      }
      const pages = [messages]
      let cursor = typeof result?.beforeOffset === 'number' ? result.beforeOffset : undefined
      let hasMore = result?.hasMore === true
      while (hasMore) {
        const earlier = asRecord(
          await read.handler(
            read.params?.parse({
              agent: 'opencode',
              sessionId: 'session',
              limit: 2000,
              beforeOffset: cursor
            }),
            ctx
          )
        )
        const entries = Array.isArray(earlier?.messages) ? earlier.messages : []
        expect(entries.length).toBeGreaterThan(0)
        const before = typeof earlier?.beforeOffset === 'number' ? earlier.beforeOffset : undefined
        expect(before).toBeLessThan(cursor!)
        cursor = before
        hasMore = earlier?.hasMore === true
        pages.unshift(entries)
      }
      const all = pages.flat()
      const ids = all.map((message) => asRecord(message)?.id)
      expect(all).toHaveLength(2402)
      expect(new Set(ids).size).toBe(2402)
      const prefix = version === 'v2' ? 'opencode:' : ''
      expect(ids).toEqual([
        `${prefix}oldest`,
        ...Array.from({ length: 1200 }, (_, index) => [
          `${prefix}${index + 1}:reasoning`,
          `${prefix}${index + 1}`
        ]).flat(),
        `${prefix}latest`
      ])
    }
  )
})

function message(id: string, offset: number, text: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    source: 'transcript',
    timestamp: 10,
    transcriptOffset: offset,
    blocks: [{ type: 'text', text }]
  }
}

it('replaces an unsendable newest raw group with one stable localized notice', () => {
  const large = [
    message('row:reasoning', 42, 'Я'.repeat(1_000_000)),
    message('row', 42, 'Я'.repeat(1_000_000))
  ]
  large[0].role = 'reasoning'
  const page = boundNativeChatRpcPageByBytes([message('older', 2, 'older'), ...large], false, 2)
  expect(page).toEqual({
    messages: [
      {
        id: 'row',
        role: 'system',
        source: 'transcript',
        timestamp: 10,
        transcriptOffset: 42,
        blocks: [
          {
            type: 'text',
            text: 'This part of the chat was too large to show.',
            presentation: 'history-item-too-large'
          }
        ]
      }
    ],
    hasMore: true,
    beforeOffset: 42
  })
  expect(Number.isFinite(mobileE2EETextPayloadAdmissionBytes(JSON.stringify(page)))).toBe(true)
  const only = boundNativeChatRpcPageByBytes(large, false, 42)
  expect(only.hasMore).toBe(false)
  expect(only.beforeOffset).toBe(42)
})

it('keeps append batches complete and admits every serialized batch', () => {
  const messages = Array.from({ length: 12 }, (_, index) => [
    message(`${index}:reasoning`, index, 'Я'.repeat(100_000)),
    message(String(index), index, 'Я'.repeat(100_000))
  ]).flat()
  for (let index = 0; index < messages.length; index += 2) {
    messages[index].role = 'reasoning'
  }
  const batches = nativeChatRpcAppendBatches(messages)
  expect(batches.length).toBeGreaterThan(1)
  expect(batches.flat()).toEqual(messages)
  for (const batch of batches) {
    expect(batch[0].role).toBe('reasoning')
    expect(batch.at(-1)?.role).toBe('assistant')
    expect(
      Number.isFinite(
        mobileE2EETextPayloadAdmissionBytes(JSON.stringify({ type: 'appended', messages: batch }))
      )
    ).toBe(true)
  }
})

it('does not manufacture a paging cursor for legacy messages without optional offsets', () => {
  const messages = [
    message('old', 1, 'Я'.repeat(700_000)),
    message('new', 2, 'Я'.repeat(700_000))
  ].map(({ transcriptOffset: _offset, ...row }) => row)
  const result = boundNativeChatRpcPageByBytes(messages, true, 90)
  expect(result.hasMore).toBe(true)
  expect(result.beforeOffset).toBe(90)
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].role).toBe('system')
  expect(result.messages[0].blocks[0]).toMatchObject({ presentation: 'history-item-too-large' })
})

it('preserves empty append lifecycle frames', async () => {
  const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.subscribe')!
  if (!isStreamingMethod(method)) {
    throw new Error('Expected a subscription')
  }
  const frames: unknown[] = []
  await method.handler(
    method.params?.parse({ agent: 'opencode2', sessionId: 'session' }),
    context(),
    (frame) => frames.push(frame)
  )
  state.watcher?.onAppend([], { state: 'completed', turnId: 'turn', timestamp: 10 })
  expect(frames).toEqual([
    {
      type: 'appended',
      messages: [],
      lifecycle: { state: 'completed', turnId: 'turn', timestamp: 10 }
    }
  ])
})
