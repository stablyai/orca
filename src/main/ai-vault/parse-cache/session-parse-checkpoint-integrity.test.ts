import { appendFile, mkdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { SessionSearchStore } from '../../ai-vault-search/session-search-store'
import { registerSessionSearchIndexConsumer } from '../../ai-vault-search/session-search-index-consumer'
import { runSessionSearchIndexPass } from '../../ai-vault-search/session-search-index-pass'
import {
  sessionCandidate,
  userRecord
} from '../../ai-vault-search/session-search-transcript-fixtures'
import { resetTranscriptConsumersForTests } from '../transcripts/session-transcript-consumers'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'
import { parseAgentSessionFileCached } from './session-scanner-parse-cache'

let root: string
let cacheFile: string
let search: SessionSearchStore | undefined

beforeEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  root = resolve('.tmp/checkpoint-integrity', randomUUID())
  await mkdir(root, { recursive: true })
  cacheFile = join(root, 'session-parse-cache.json')
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'checkpoint-test' })
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  search?.close()
  search = undefined
  await rm(root, { recursive: true, force: true })
})

function restart(): void {
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'checkpoint-test' })
}

async function scan(path: string) {
  return parseAgentSessionFileCached(await sessionCandidate('claude', path), process.platform)
}

it('lists replacement content when a file replaces the checkpointed path after restart', async () => {
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${userRecord(0, 'outdated')}\n`)
  await scan(path)
  await flushSessionParseCachePersist()
  restart()

  const replacement = join(root, 'replacement.jsonl')
  await writeFile(replacement, `${userRecord(0, 'replaced')}\n${userRecord(1, 'new message')}\n`)
  const previous = await stat(path)
  const modified = new Date(previous.mtimeMs + 2000)
  await utimes(replacement, modified, modified)
  await rename(replacement, path)

  const session = await scan(path)
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'replaced',
    'new message'
  ])
})

it('retains appended messages when a corrupt checkpoint exceeds its recorded file size', async () => {
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${userRecord(0, 'original')}\n`)
  await scan(path)
  await flushSessionParseCachePersist()
  restart()

  const firstAppend = `${userRecord(1, 'first append')}\n`
  await appendFile(path, `${firstAppend}${userRecord(2, 'second append')}\n`)
  const database = new SyncDatabase(join(root, 'session-parse-cache.sqlite'))
  try {
    const row = database.prepare('SELECT checkpoint FROM rows WHERE path = ?').get(path)
    if (typeof row?.checkpoint !== 'string') {
      throw new Error('Missing persisted checkpoint')
    }
    const checkpoint = JSON.parse(row.checkpoint)
    database.prepare('UPDATE rows SET checkpoint = ? WHERE path = ?').run(
      JSON.stringify({
        ...checkpoint,
        byteOffset: checkpoint.byteOffset + Buffer.byteLength(firstAppend)
      }),
      path
    )
  } finally {
    database.close()
  }

  const session = await scan(path)
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'original',
    'first append',
    'second append'
  ])
})

it('replaces stale indexed content when a transcript prefix changes across restart', async () => {
  const path = join(root, 'session.jsonl')
  const indexPath = join(root, 'search.sqlite')
  search = new SessionSearchStore(indexPath)
  registerSessionSearchIndexConsumer(search)
  await writeFile(path, `${userRecord(0, 'outdated')}\n`)
  await scan(path)
  await flushSessionParseCachePersist()
  const previous = await stat(path)
  resetTranscriptConsumersForTests()
  search.close()
  restart()

  search = new SessionSearchStore(indexPath)
  registerSessionSearchIndexConsumer(search)
  await writeFile(path, `${userRecord(0, 'replaced')}\n${userRecord(1, 'new message')}\n`)
  const modified = new Date(previous.mtimeMs + 2000)
  await utimes(path, modified, modified)
  await scan(path)
  await runSessionSearchIndexPass(search, [await sessionCandidate('claude', path)], {
    rows: new Map(search.files().map((row) => [row.path, row]))
  })

  const rows = search.connection
    .prepare(
      `SELECT f.user_text FROM messages_fts f
     JOIN messages m ON m.id = f.rowid
     JOIN sessions s ON s.id = m.session_row_id ORDER BY m.id`
    )
    .all()
  expect(rows.map((row) => row.user_text)).toEqual(['replaced', 'new message'])
})
