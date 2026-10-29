import { appendFile, mkdir, stat, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { isAiVaultScanCancelledError } from '../../shared/ai-vault-types'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { resetCursorChatMetaIndexCacheForTests } from '../ai-vault/session-scanner-cursor-chat-meta'
import { SessionSearchEngine } from './session-search-engine'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import {
  openSessionSearchIndexFile,
  type SessionSearchIndexFile
} from './session-search-index-test-fixture'
import { SessionSearchStore } from './session-search-store'
import { sessionCandidate } from './session-search-transcript-fixtures'
import { readWholeTranscript } from '../ai-vault/session-transcript-reader'

let index: SessionSearchIndexFile
let store: SessionSearchStore
let engine: SessionSearchEngine
let errors: unknown[]
const EARLIER = '2026-10-01T10:00:00.125Z'
const LATER = '2026-10-20T10:00:00.875Z'
const SINCE = '2026-10-10T00:00:00.000Z'

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  resetCursorChatMetaIndexCacheForTests()
  index = await openSessionSearchIndexFile('ss-cursor-timestamps')
  errors = []
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(store)
  engine = new SessionSearchEngine(index.db)
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  resetCursorChatMetaIndexCacheForTests()
  store.close()
  await index.close()
})

async function cursorTranscript(id: string, modifiedAt: string, timestamp?: string) {
  const path = join(
    dirname(index.path),
    '.cursor',
    'projects',
    'app',
    'agent-transcripts',
    id,
    `${id}.jsonl`
  )
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text: `timestampneedle ${id}` }] }, ...(timestamp ? { timestamp } : {}) })}\n`
  )
  await utimes(path, new Date(modifiedAt), new Date(modifiedAt))
  const candidate = await sessionCandidate('cursor', path)
  const session = await parseAgentSessionFileCached(candidate, process.platform)
  expect(errors).toEqual([])
  return { path, candidate, session }
}

it('finds undated Cursor transcripts by since and newest using their file times', async () => {
  const recent = await cursorTranscript('recent', LATER)
  await cursorTranscript('older', EARLIER)
  expect(recent.session).toMatchObject({ createdAt: null, updatedAt: null, modifiedAt: LATER })

  const hits = engine.search({
    query: 'timestampneedle',
    filters: { agents: ['cursor'], since: SINCE, sort: 'newest' }
  }).hits
  expect(hits.map((hit) => [hit.sessionId, hit.updatedAt])).toEqual([['recent', LATER]])
  expect(
    engine
      .search({ query: 'timestampneedle', filters: { sort: 'newest' } })
      .hits.map((hit) => hit.sessionId)
  ).toEqual(['recent', 'older'])
  expect(
    engine
      .search({
        query: 'path:agent-transcripts',
        filters: { agents: ['cursor'], since: SINCE, sort: 'newest' }
      })
      .hits.map((hit) => hit.sessionId)
  ).toEqual(['recent'])
  expect(hits[0]?.evidence?.timestamp).toBeNull()
})

it('advances the fallback after an append without inventing message timestamps', async () => {
  const { path } = await cursorTranscript('appended', EARLIER)
  expect(engine.search({ query: 'timestampneedle', filters: { since: SINCE } }).hits).toEqual([])
  await appendFile(
    path,
    `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'followupneedle' }] } })}\n`
  )
  await utimes(path, new Date(LATER), new Date(LATER))
  await parseAgentSessionFileCached(await sessionCandidate('cursor', path), process.platform)
  expect(errors).toEqual([])
  expect(engine.search({ query: 'followupneedle', filters: { since: SINCE } }).hits).toMatchObject([
    { sessionId: 'appended', updatedAt: LATER, evidence: { timestamp: null } }
  ])
})

it('keeps a real transcript timestamp even when its file is newer', async () => {
  await cursorTranscript('dated', LATER, EARLIER)
  expect(engine.search({ query: 'timestampneedle', filters: { since: SINCE } }).hits).toEqual([])
  expect(engine.search({ query: 'timestampneedle' }).hits).toMatchObject([{ updatedAt: EARLIER }])
})

it('prefers the Cursor metadata timestamp over the transcript file time', async () => {
  const { path } = await cursorTranscript('sidecar', LATER)
  const metaPath = join(dirname(index.path), '.cursor', 'chats', 'app', 'sidecar', 'meta.json')
  await mkdir(dirname(metaPath), { recursive: true })
  await writeFile(metaPath, JSON.stringify({ updatedAtMs: Date.parse(EARLIER), cwd: '/repo/app' }))
  resetSessionParseCacheForTests()
  resetCursorChatMetaIndexCacheForTests()
  const candidate = await sessionCandidate('cursor', path)
  const metaStat = await stat(metaPath)
  candidate.file.sidecar = { path: metaPath, mtimeMs: metaStat.mtimeMs, sizeBytes: metaStat.size }
  const session = await parseAgentSessionFileCached(candidate, process.platform)
  expect(session?.updatedAt).toBe(EARLIER)
  expect(errors).toEqual([])
  expect(engine.search({ query: 'timestampneedle', filters: { since: SINCE } }).hits).toEqual([])
  expect(engine.search({ query: 'timestampneedle' }).hits).toMatchObject([
    { updatedAt: EARLIER, cwd: '/repo/app' }
  ])
  await appendFile(
    path,
    `${JSON.stringify({ role: 'assistant', message: { content: [{ type: 'text', text: 'sidecarappendneedle' }] } })}\n`
  )
  await parseAgentSessionFileCached(await sessionCandidate('cursor', path), process.platform)
  expect(engine.search({ query: 'sidecarappendneedle' }).hits).toMatchObject([
    { updatedAt: EARLIER, cwd: '/repo/app' }
  ])
})

it('does not commit a read cancelled while completing consumer metadata', async () => {
  const { path } = await cursorTranscript('cancelled', EARLIER)
  const before = index.db.prepare('SELECT * FROM files').all()
  const controller = new AbortController()
  await expect(
    readWholeTranscript({
      candidate: await sessionCandidate('cursor', path),
      platform: process.platform,
      signal: controller.signal,
      sessionForConsumers: async (session) => {
        controller.abort()
        return session
      }
    })
  ).rejects.toSatisfy(isAiVaultScanCancelledError)
  expect(errors).toEqual([])
  expect(index.db.prepare('SELECT * FROM files').all()).toEqual(before)
  expect(index.db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 1 })
})

it('repairs existing null Cursor dates on reopen without rebuilding search content', async () => {
  const { candidate } = await cursorTranscript('cached', LATER)
  index.db.prepare('UPDATE sessions SET updated_at = NULL').run()
  // APFS and NTFS record sub-millisecond mtimes; the repair must truncate like Date#toISOString.
  index.db.prepare('UPDATE files SET mtime_ms = mtime_ms + 0.6').run()
  const incarnation = index.db
    .prepare("SELECT value FROM meta WHERE key = 'index_incarnation'")
    .get()
  const content = index.db.prepare('SELECT id, session_row_id FROM messages').all()
  store.close()
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  expect(errors).toEqual([])
  expect(index.db.prepare("SELECT value FROM meta WHERE key = 'index_incarnation'").get()).toEqual(
    incarnation
  )
  expect(index.db.prepare('SELECT id, session_row_id FROM messages').all()).toEqual(content)
  expect(index.db.prepare('SELECT byte_offset, mtime_ms FROM files').get()).toEqual({
    byte_offset: candidate.file.sizeBytes,
    mtime_ms: candidate.file.mtimeMs + 0.6
  })
  expect(engine.search({ query: 'timestampneedle', filters: { since: SINCE } }).hits).toMatchObject(
    [{ sessionId: 'cached', updatedAt: LATER }]
  )
})

it('does not repair an authoritative date or another provider from file metadata', async () => {
  await cursorTranscript('dated', LATER, EARLIER)
  await cursorTranscript('other-provider', LATER)
  index.db
    .prepare(
      "UPDATE sessions SET agent = 'claude', updated_at = NULL WHERE session_id = 'other-provider'"
    )
    .run()
  store.close()
  store = new SessionSearchStore(index.path, (error) => errors.push(error))
  expect(
    index.db.prepare('SELECT session_id, updated_at FROM sessions ORDER BY session_id').all()
  ).toEqual([
    { session_id: 'dated', updated_at: EARLIER },
    { session_id: 'other-provider', updated_at: null }
  ])
})
