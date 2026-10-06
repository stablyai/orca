import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { asRecord } from '../../../ai-vault/session-scanner-values'
import { readOpenCodeTranscriptPage } from '../../../native-chat/transcript-opencode-sqlite-query'
import { readOpenCodeNativeChatTranscriptTail } from '../../../native-chat/transcript-opencode'
import type { SubscribeNativeChatTranscriptArgs } from '../../../native-chat/transcript-watch-contract'
import { buildRegistry, isStreamingMethod, type RpcContext } from '../core'

const state: { path: string; watcher: SubscribeNativeChatTranscriptArgs | null } = vi.hoisted(
  () => ({
    path: '',
    watcher: null
  })
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

const roots: string[] = []
afterEach(() => {
  state.watcher = null
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-opencode-paired-pages-'))
  roots.push(root)
  state.path = join(root, 'opencode.db')
  const db = new Database(state.path)
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
    CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      data TEXT, time_created INTEGER, time_updated INTEGER);
    INSERT INTO session_v2 VALUES ('session');`)
  for (let index = 1; index <= 3; index++) {
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      String(index),
      'session',
      'assistant',
      index * 7,
      JSON.stringify({
        content: [
          { type: 'reasoning', text: `thinking ${index}` },
          { type: 'text', text: `answer ${index}` }
        ]
      }),
      1,
      1
    )
  }
  db.close()
}

function context(): RpcContext {
  const runtime = { registerSubscriptionCleanup: vi.fn(), cleanupSubscription: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These handlers only register or invoke subscription cleanup on the runtime.
  return { runtime: runtime as unknown as RpcContext['runtime'], clientKind: 'mobile' }
}

describe.each(['opencode', 'opencode2'])('%s paired semantic pages', (agent) => {
  it('reconstructs reasoning and answers across raw-row cursors at limit 1', async () => {
    fixture()
    const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.readSession')!
    if (isStreamingMethod(method)) {
      throw new Error('Expected a page read')
    }
    const pages: string[][] = []
    let beforeOffset: number | undefined
    for (let index = 0; index < 4; index++) {
      const params = method.params?.parse({ agent, sessionId: 'session', limit: 1, beforeOffset })
      const result = asRecord(await method.handler(params, context()))
      expect(result?.hasMore).toBe(index < 2)
      const messages = Array.isArray(result?.messages) ? result.messages : []
      expect(messages.map((message) => asRecord(message)?.role)).toEqual(['reasoning', 'assistant'])
      pages.push(messages.map((message) => String(asRecord(message)?.id)))
      if (result?.hasMore !== true) {
        break
      }
      expect(typeof result.beforeOffset).toBe('number')
      beforeOffset = typeof result.beforeOffset === 'number' ? result.beforeOffset : undefined
    }
    expect(pages.toReversed().flat()).toEqual([
      'opencode:1:reasoning',
      'opencode:1',
      'opencode:2:reasoning',
      'opencode:2',
      'opencode:3:reasoning',
      'opencode:3'
    ])
  })

  it('keeps the pair in snapshot and replacement frames while sanitizing mobile text', async () => {
    fixture()
    const method = buildRegistry(NATIVE_CHAT_METHODS).get('nativeChat.subscribe')!
    if (!isStreamingMethod(method)) {
      throw new Error('Expected a subscription')
    }
    const frames: unknown[] = []
    await method.handler(
      method.params?.parse({ agent, sessionId: 'session', limit: 1 }),
      context(),
      (frame) => frames.push(frame)
    )
    const page = readOpenCodeTranscriptPage({ dbPath: state.path, sessionId: 'session', limit: 1 })!
    const messages = page.items.map((item) => item.message)
    messages[0].blocks = [{ type: 'text', text: 'x'.repeat(100_000) }]
    const watcher = state.watcher
    if (!watcher) {
      throw new Error('Expected a native watcher')
    }
    watcher.onInitialSnapshot?.(messages, page.hasMore, page.beforeMessageRowId ?? 0)
    watcher.onReplace?.(messages, page.hasMore, page.beforeMessageRowId ?? 0)
    expect(frames).toHaveLength(2)
    for (const frame of frames) {
      const record = asRecord(frame)
      const published = Array.isArray(record?.messages) ? record.messages : []
      expect(published.map((message) => asRecord(message)?.role)).toEqual([
        'reasoning',
        'assistant'
      ])
      expect(record?.beforeOffset).toBe(page.beforeMessageRowId)
      expect(JSON.stringify(published).length).toBeLessThan(100_000)
    }
    expect(messages[0].blocks[0]).toEqual({ type: 'text', text: 'x'.repeat(100_000) })
  })
})
