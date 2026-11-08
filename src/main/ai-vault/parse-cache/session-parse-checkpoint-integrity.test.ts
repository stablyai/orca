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
import { readResumableTranscript } from '../transcripts/session-transcript-reader'
import { createClaudeSessionResumeState } from '../scanners/claude/session-scanner-claude-checkpoint'
import { checkpointResumeFor, sessionParseCheckpointOf } from './session-parse-checkpoint-restore'

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

it('continues history and search from their shared cursor across consecutive restarts', async () => {
  const path = join(root, 'session.jsonl')
  const indexPath = join(root, 'search.sqlite')
  search = new SessionSearchStore(indexPath)
  registerSessionSearchIndexConsumer(search)
  await writeFile(
    path,
    `${userRecord(0, 'original')}\n${JSON.stringify({ type: 'progress', padding: 'x'.repeat(32768) })}\n`
  )
  await scan(path)
  await flushSessionParseCachePersist()

  for (const index of [1, 2]) {
    resetTranscriptConsumersForTests()
    search.close()
    restart()
    search = new SessionSearchStore(indexPath)
    registerSessionSearchIndexConsumer(search)
    await appendFile(path, `${userRecord(index, `append ${index}`)}\n`)
    const result = await runSessionSearchIndexPass(
      search,
      [await sessionCandidate('claude', path)],
      {
        rows: new Map(search.files().map((row) => [row.path, row]))
      }
    )
    expect(result.stats.fullParses).toBe(0)
    expect(result.stats.incremental).toBe(1)
    expect(result.stats.bytesRead).toBeLessThan(20000)
    await flushSessionParseCachePersist()
  }
  const session = await scan(path)
  expect(session?.messageCount).toBe(3)
  expect(session?.previewMessages.map((message) => message.text)).toEqual([
    'original',
    'append 1',
    'append 2'
  ])
  const rows = search.connection.prepare('SELECT user_text FROM messages_fts ORDER BY rowid').all()
  expect(rows.map((row) => row.user_text)).toEqual(['original', 'append 1', 'append 2'])
})

it('indexes the complete transcript when search starts without a saved index', async () => {
  const path = join(root, 'session.jsonl')
  await writeFile(path, `${userRecord(0, 'original')}\n`)
  await scan(path)
  await flushSessionParseCachePersist()
  restart()
  await appendFile(path, `${userRecord(1, 'new message')}\n`)
  search = new SessionSearchStore(join(root, 'search.sqlite'))
  registerSessionSearchIndexConsumer(search)
  await runSessionSearchIndexPass(search, [await sessionCandidate('claude', path)], {
    rows: new Map()
  })
  const rows = search.connection.prepare('SELECT user_text FROM messages_fts ORDER BY rowid').all()
  expect(rows.map((row) => row.user_text)).toEqual(['original', 'new message'])
})

it('keeps a completed parse checkpoint usable when the transcript rotates before publication', async () => {
  const path = join(root, 'session.jsonl')
  const rotated = join(root, 'rotated.jsonl')
  await writeFile(path, `${userRecord(0, 'original')}\n`)
  const candidate = await sessionCandidate('claude', path)
  const read = await readResumableTranscript({
    candidate,
    platform: process.platform,
    resume: null,
    stateFactory: (messages) => createClaudeSessionResumeState(candidate.file, messages),
    sessionForConsumers: async (session) => {
      await rename(path, rotated)
      return session
    }
  })
  const checkpoint = sessionParseCheckpointOf(candidate, read.resume)
  if (!checkpoint) {
    throw new Error('Missing completed checkpoint')
  }
  await appendFile(rotated, `${userRecord(1, 'after rotation')}\n`)
  const next = await sessionCandidate('claude', rotated)
  const resumed = await readResumableTranscript({
    candidate: next,
    platform: process.platform,
    resume: await checkpointResumeFor(next, checkpoint),
    stateFactory: (messages) => createClaudeSessionResumeState(next.file, messages)
  })
  expect(resumed.session?.previewMessages.map((message) => message.text)).toEqual([
    'original',
    'after rotation'
  ])
})

it('restores samples across a multi-chunk record and an unfinished UTF-8 tail', async () => {
  const path = join(root, 'session.jsonl')
  const tail = Buffer.from(userRecord(1, '\u4f60\u597d'))
  const split = tail.indexOf(Buffer.from('\u4f60')) + 1
  await writeFile(
    path,
    Buffer.concat([
      Buffer.from(
        `${userRecord(0, 'original')}\n${JSON.stringify({ type: 'progress', padding: 'x'.repeat(140000) })}\n`
      ),
      tail.subarray(0, split)
    ])
  )
  await scan(path)
  await flushSessionParseCachePersist()
  restart()
  await appendFile(path, Buffer.concat([tail.subarray(split), Buffer.from('\n')]))
  const completed = await scan(path)
  expect(completed?.messageCount).toBe(2)
  expect(completed?.previewMessages.map((message) => message.text)).toEqual([
    'original',
    '\u4f60\u597d'
  ])
  await flushSessionParseCachePersist()
  restart()
  await appendFile(path, `${userRecord(2, 'after completion')}\n`)
  const next = await scan(path)
  expect(next?.previewMessages.map((message) => message.text)).toEqual([
    'original',
    '\u4f60\u597d',
    'after completion'
  ])
})
