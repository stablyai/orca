import './session-search-worker.test-fixture'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionSearchWorkerStore } from './session-search-worker-store'
import { SessionSearchReaders } from './session-search-readers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { syntheticCandidate } from './session-search-index-test-fixture'
import { readWholeTranscript } from '../ai-vault/transcripts/session-transcript-reader'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import { createHash } from 'node:crypto'
import SyncDatabase from '../sqlite/sync-database'

let root: string | undefined
let store: SessionSearchWorkerStore | undefined
let readers: SessionSearchReaders | undefined

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store?.close()
  await Promise.all([store?.retired(), readers?.close()])
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

// Real workers import the parser graph; allow cold module loading plus SQLite publication.
it(
  'indexes a non-JSONL pass larger than transfer credits without losing rows or original-message hashes',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'ss-worker-flow-'))
    const path = join(root, 'index.sqlite')
    const file = join(root, 'conversation.json')
    const text = 'observable payload '.repeat(7000)
    await writeFile(
      file,
      JSON.stringify({
        id: 'worker-session',
        working_dir: root,
        messages: [
          ...Array.from({ length: 40 }, () => ({ role: 'user', content: text })),
          { role: 'assistant', content: 'workerneedle reached the end' }
        ]
      })
    )
    const info = await stat(file)
    const candidate = {
      ...syntheticCandidate({ path: file, mtimeMs: info.mtimeMs, sizeBytes: info.size }),
      agent: 'jcode' as const
    }
    store = new SessionSearchWorkerStore(path, (error) => {
      throw error
    })
    await store.prepare()
    registerSessionSearchIndexConsumer(store)
    const listed = await readWholeTranscript({ candidate, platform: process.platform })
    await store.flush()
    expect(listed?.messageCount).toBe(41)
    expect(store.stateCounts()).toMatchObject({ current: 0, due: 0, failed: 0, messages: 0 })
    expect(store.coversTranscript(candidate)).toBe(false)
    await readWholeTranscript({ candidate, platform: process.platform, indexing: true })
    await store.flush()
    readers = new SessionSearchReaders(path, null)
    expect((await readers.query({ query: 'workerneedle' })).result).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: 'worker-session' }]
    })
    expect(store.coversTranscript(candidate)).toBe(true)
    expect(store.stateCounts().failed).toBe(0)
    const db = new SyncDatabase(path, { readonly: true })
    try {
      let digest = ''
      for (let i = 0; i < 8; i++) {
        digest = createHash('sha256').update(digest).update('\0user\0').update(text).digest('hex')
      }
      expect(
        db.prepare('SELECT content_hash, content_hash_count FROM sessions').get()
      ).toMatchObject({ content_hash: digest, content_hash_count: 8 })
    } finally {
      db.close()
    }
  },
  // Why: these start real writer and reader worker threads (tsx-loaded) and stream multi-MiB transcripts.
  30_000
)

it('cancels a dead writer handle and lets a fresh pass recover without failing the transcript', async () => {
  root = await mkdtemp(join(tmpdir(), 'ss-worker-recovery-'))
  const path = join(root, 'index.sqlite')
  class RestartableStore extends SessionSearchWorkerStore {
    stopWriter(): void {
      this.client.stop()
    }
  }
  const subject = new RestartableStore(path, (error) => {
    throw error
  })
  store = subject
  await subject.prepare()
  const candidate = syntheticCandidate()
  const interrupted = subject.beginWrite(candidate, 'replace', 0, undefined, true)!
  interrupted.add({ role: 'user', text: 'interrupted payload', timestamp: null })
  subject.stopWriter()
  await expect(interrupted.drain!()).rejects.toMatchObject({ name: 'AbortError' })
  expect(interrupted.cancelled?.()).toBe(true)
  await subject.prepare()
  expect(subject.stateCounts().failed).toBe(0)
  const recovered = subject.beginWrite(candidate, 'replace', 0, undefined, true)!
  recovered.add({ role: 'user', text: 'recoveredneedle', timestamp: null })
  const { syntheticSession } = await import('./session-search-index-test-fixture')
  recovered.commit({ session: syntheticSession(), byteOffset: 4096, incomplete: false })
  await subject.flush()
  readers = new SessionSearchReaders(path, null)
  expect((await readers.query({ query: 'recoveredneedle' })).result).toMatchObject({
    kind: 'results',
    hits: [{ sessionId: 'fixture' }]
  })
  expect(subject.stateCounts().failed).toBe(0)
})

it(
  'drains a near-10-MiB JSONL record even when one synchronous emission exceeds transfer credits',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'ss-worker-burst-'))
    const path = join(root, 'index.sqlite')
    const file = join(root, 'burst.jsonl')
    const text = `largestburstneedle ${'x '.repeat(5 * 1024 * 1024 - 1024)}`
    const { writeClaudeTranscript } = await import('./session-search-indexer-test-fixture')
    await writeClaudeTranscript(file, [text], 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    const info = await stat(file)
    const candidate = syntheticCandidate({
      path: file,
      mtimeMs: info.mtimeMs,
      sizeBytes: info.size
    })
    store = new SessionSearchWorkerStore(path, (error) => {
      throw error
    })
    await store.prepare()
    registerSessionSearchIndexConsumer(store)
    const { readResumableTranscript } =
      await import('../ai-vault/transcripts/session-transcript-reader')
    const { createClaudeSessionResumeState } =
      await import('../ai-vault/scanners/claude/session-scanner-primary-parsers')
    await readResumableTranscript({
      candidate,
      platform: process.platform,
      resume: null,
      indexing: true,
      stateFactory: (channel) => createClaudeSessionResumeState(candidate.file, channel)
    })
    await store.flush()
    expect(store.coversTranscript(candidate)).toBe(true)
    expect(store.stateCounts().failed).toBe(0)
    readers = new SessionSearchReaders(path, null)
    expect((await readers.query({ query: 'largestburstneedle' })).result).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }]
    })
  },
  // Why: these start real writer and reader worker threads (tsx-loaded) and stream multi-MiB transcripts.
  30_000
)

it('commits the original-message digest when a drained conversation ends with only tool rows', async () => {
  root = await mkdtemp(join(tmpdir(), 'ss-worker-hash-tail-'))
  const path = join(root, 'index.sqlite')
  store = new SessionSearchWorkerStore(path, (error) => {
    throw error
  })
  await store.prepare()
  const write = store.beginWrite(syntheticCandidate(), 'replace', 0, undefined, true)!
  write.add({ role: 'user', text: 'prompt', timestamp: null })
  await write.drain!()
  await store.flush()
  write.add({ role: 'tool', text: 'tooltail', timestamp: null })
  const { syntheticSession } = await import('./session-search-index-test-fixture')
  expect(write.commit({ session: syntheticSession(), byteOffset: 4096, incomplete: false })).toBe(
    true
  )
  await store.flush()
  const db = new SyncDatabase(path, { readonly: true })
  try {
    expect(db.prepare('SELECT content_hash, content_hash_count FROM sessions').get()).toEqual({
      content_hash: '20d617e013f1dbefe8ce6afe43ad44ec558ae2e087d44804ce2f789cc04538a8',
      content_hash_count: 2
    })
    expect(db.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 })
  } finally {
    db.close()
  }
})

it('opens a cold reader and searches committed rows while a writer batch remains uncommitted', async () => {
  root = await mkdtemp(join(tmpdir(), 'ss-reader-independent-'))
  const path = join(root, 'index.sqlite')
  const { SessionSearchStore } = await import('./session-search-store')
  const { addSyntheticSession } = await import('./session-search-engine-test-fixture')
  const writer = new SessionSearchStore(path)
  try {
    addSyntheticSession(writer.connection, { id: 1, text: 'independentneedle' })
    writer.connection.exec('BEGIN IMMEDIATE')
    writer.connection.prepare("UPDATE sessions SET title = 'uncommitted' WHERE id = 1").run()
    readers = new SessionSearchReaders(path, null)
    expect((await readers.query({ query: 'independentneedle' })).result).toMatchObject({
      kind: 'results',
      hits: [{ sessionId: '1', title: 'fixture' }]
    })
  } finally {
    if (writer.connection.isTransaction) {
      writer.connection.exec('ROLLBACK')
    }
    writer.close()
  }
})
