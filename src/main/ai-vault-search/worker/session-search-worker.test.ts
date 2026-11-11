import './session-search-worker.test-fixture'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSearchWorkQueue, type SessionSearchReadContext } from '../session-search-work-queue'
import {
  SessionSearchWorkerClient,
  SessionSearchOperationError
} from './session-search-worker-client'
import { SessionSearchWorkerStore } from './session-search-worker-store'
import { SessionSearchReaders } from './session-search-readers'
import '../indexing/session-search-index-consumer'
import { syntheticCandidate, syntheticSession } from '../storage/session-search-index-test-fixture'
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

it('retains retry fairness through a lost finish reply and a new queue owner', async () => {
  root = await mkdtemp(join(tmpdir(), 'ss-finish-retry-'))
  store = new SessionSearchWorkerStore(join(root, 'index.sqlite'), () => undefined)
  await store.prepare()
  const queue = new SessionSearchWorkQueue()
  const changed = syntheticCandidate({ path: join(root, 'changed.jsonl'), sizeBytes: 1024 })
  const backlog = syntheticCandidate({ path: join(root, 'backlog.jsonl'), sizeBytes: 4096 })
  const newer = syntheticCandidate({ path: join(root, 'newer.jsonl'), sizeBytes: 4096 })
  await queue.enqueue(changed, store)
  await queue.enqueue(backlog, store, false, false)
  await queue.enqueue(newer, store)
  queue.beginPass()
  const work = (await queue.next())!
  expect(work.candidate.file.path).toBe(changed.file.path)
  const read: SessionSearchReadContext = { receipt: work.receipt! }
  const request = SessionSearchWorkerClient.prototype.request
  let lost = false
  const traffic = vi
    .spyOn(SessionSearchWorkerClient.prototype, 'request')
    .mockImplementation(async function (this: SessionSearchWorkerClient, command) {
      const response = await request.call(this, command)
      if (command.op === 'finish' && !lost) {
        lost = true
        throw new SessionSearchOperationError('fixture lost finish reply')
      }
      return response
    })
  try {
    const write = store.beginWrite(changed, 'replace', 0, undefined, true, undefined, false, read)!
    write.add({ role: 'user', text: 'acceptedretryneedle', timestamp: null })
    write.commit({
      session: syntheticSession({ filePath: changed.file.path }),
      byteOffset: 4096,
      incomplete: false
    })
    await store.flush()
    expect(lost).toBe(true)
    expect(await read.settlement).toBeUndefined()
    await queue.acknowledge(work, true)
    const successor = new SessionSearchWorkQueue()
    successor.attach(store)
    successor.beginPass()
    const next = (await successor.next())!
    expect(next.candidate.file.path).toBe(backlog.file.path)
    await successor.acknowledge(next, false)
    const nextChange = (await successor.next())!
    expect(nextChange.candidate.file.path).toBe(newer.file.path)
    await successor.acknowledge(nextChange, false)
    expect((await successor.next())?.candidate.file.path).toBe(changed.file.path)
  } finally {
    traffic.mockRestore()
  }
})

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
