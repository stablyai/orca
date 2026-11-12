import './session-search-worker.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { SessionSearchWorkerStore } from './session-search-worker-store'
import { SessionSearchReaders } from './session-search-readers'
import '../indexing/session-search-index-consumer'
import { syntheticCandidate } from '../storage/session-search-index-test-fixture'
import '../../ai-vault/transcripts/session-transcript-reader'
import { resetTranscriptConsumersForTests } from '../../ai-vault/transcripts/session-transcript-consumers'
import 'node:crypto'
import SyncDatabase from '../../sqlite/sync-database'

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
  const { syntheticSession } = await import('../storage/session-search-index-test-fixture')
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
  const { SessionSearchStore } = await import('../storage/session-search-store')
  const { addSyntheticSession } = await import('../query/session-search-engine-test-fixture')
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
