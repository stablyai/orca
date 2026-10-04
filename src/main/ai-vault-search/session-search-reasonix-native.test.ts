import { appendFile, copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { SessionSearchIndexer } from './session-search-indexer'
import { SessionSearchEngine } from './session-search-engine'
import {
  openSessionSearchIndexerHarness,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const id = '985b66b859ffae5cd8d17ef63ec3d33c'
const fixture = (extension: string) =>
  join(__dirname, '../ai-vault/__fixtures__', `reasonix-1-39-7-native-auth-rejection${extension}`)
let harness: SessionSearchIndexerHarness
let indexer: SessionSearchIndexer
let connection: SyncDatabase | undefined
let path: string
beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  harness = await openSessionSearchIndexerHarness('rx-native-index')
  path = join(harness.root, 'reasonix/projects/-workspace/sessions-v4', id, 'events.frames')
  await mkdir(dirname(path), { recursive: true })
  await copyFile(fixture('-initial.frames'), path)
  await copyFile(fixture('.manifest.json'), join(dirname(path), 'manifest.json'))
  indexer = new SessionSearchIndexer({
    databasePath: harness.databasePath,
    roots: {
      ...harness.roots,
      includeReasonixHistory: true,
      reasonixWorkspaceRoots: ['/workspace']
    },
    historyDays: null
  })
  await indexer.start()
  connection = new SyncDatabase(harness.databasePath)
})
afterEach(async () => {
  connection?.close()
  connection = undefined
  indexer.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})
function search(query: string) {
  if (!connection) {
    throw new Error('Missing index connection')
  }
  return new SessionSearchEngine(connection).search({ query, filters: { agents: ['reasonix'] } })
}

it('indexes native failed-turn input without inventing assistant output, and publishes committed appends', async () => {
  expect(search('loopback').hits).toMatchObject([
    { agent: 'reasonix', sessionId: id, cwd: '/workspace' }
  ])
  expect(search('observer').hits).toEqual([])
  const initial = await readFile(path)
  const complete = await readFile(fixture('.frames'))
  expect(complete.subarray(0, initial.length)).toEqual(initial)
  await appendFile(path, complete.subarray(initial.length, initial.length + 17))
  await indexer.reconcile({ full: true })
  expect(search('observer').hits).toEqual([])
  await appendFile(path, complete.subarray(initial.length + 17))
  await indexer.reconcile({ full: true })
  expect(search('observer').hits).toMatchObject([
    { agent: 'reasonix', sessionId: id, cwd: '/workspace', evidence: { role: 'user' } }
  ])
  expect(
    harness.read((db) =>
      db.prepare("SELECT count(*) AS n FROM messages WHERE role = 'assistant'").get()
    )
  ).toEqual({ n: 0 })
  expect(indexer.status().filesFailed).toBe(0)
})

it('replaces the published projection after a new inode replaces native history', async () => {
  await copyFile(fixture('.frames'), path)
  await indexer.reconcile({ full: true })
  expect(search('observer').hits).toHaveLength(1)
  await copyFile(fixture('-initial.frames'), `${path}.replacement`)
  await rename(`${path}.replacement`, path)
  await indexer.reconcile({ full: true })
  expect(search('observer').hits).toEqual([])
  expect(search('loopback').hits).toHaveLength(1)
})

it('marks corruption as a failed source without publishing injected text', async () => {
  await writeFile(path, 'BAD!\ninjected-content')
  await indexer.reconcile({ full: true })
  expect(indexer.status().filesFailed).toBe(1)
  expect(search('injected').hits).toEqual([])
})

it('refreshes source metadata and revokes resume authority after corruption without a frame change', async () => {
  const before = await stat(path)
  const manifestPath = join(dirname(path), 'manifest.json')
  const original = await readFile(manifestPath)
  await writeFile(
    manifestPath,
    original.toString().replace('"storageRevision": 3', '"storageRevision": 4')
  )
  await indexer.reconcile({ full: true })
  expect(indexer.status().filesFailed).toBe(1)
  expect(search('loopback').hits).toMatchObject([{ cwd: null, resumeCommand: '' }])
  await copyFile(fixture('.manifest.json'), manifestPath)
  await indexer.reconcile({ full: true })
  expect(indexer.status().filesFailed).toBe(0)
  expect(search('loopback').hits).toMatchObject([
    { cwd: '/workspace', resumeCommand: expect.stringContaining(id) }
  ])
  const after = await stat(path)
  expect({ size: after.size, mtime: after.mtimeMs, ino: after.ino }).toEqual({
    size: before.size,
    mtime: before.mtimeMs,
    ino: before.ino
  })
})

it('reads an added native Desktop header and rejects conflicting workspace ownership', async () => {
  const headerPath = join(dirname(path), 'header.json')
  const header = {
    schemaVersion: 1,
    sessionId: id,
    cwd: '/workspace',
    origin: 'new',
    parentSessionId: '',
    createdAt: '2020-01-01T00:00:00Z'
  }
  await writeFile(headerPath, JSON.stringify(header))
  await indexer.reconcile({ full: true })
  expect(indexer.status().filesFailed).toBe(0)
  expect(search('loopback').hits).toMatchObject([{ cwd: '/workspace' }])
  await writeFile(headerPath, JSON.stringify({ ...header, cwd: '/unrelated' }))
  await indexer.reconcile({ full: true })
  expect(indexer.status().filesFailed).toBe(1)
  expect(search('loopback').hits).toMatchObject([{ cwd: null, resumeCommand: '' }])
})
