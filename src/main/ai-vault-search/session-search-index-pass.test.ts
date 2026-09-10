import { appendFile, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { registerSessionSearchIndexConsumer } from './session-search-index-consumer'
import { runSessionSearchIndexPass } from './session-search-index-pass'
import { parseTranscript } from './session-search-transcript-fixtures'
import {
  claudeLines,
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'
import { SessionSearchCycleAllowance } from './session-search-reconcile-budget'
import { discoverSessionSearchCandidates } from './session-search-scan-roots'
import { SessionSearchStore } from './session-search-store'

const FIRST = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SECOND = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let harness: SessionSearchIndexerHarness
let store: SessionSearchStore
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  harness = await openSessionSearchIndexerHarness('ss-index-pass')
  await writeClaudeTranscript(transcript(FIRST), ['the first transcript'], FIRST)
  await writeClaudeTranscript(transcript(SECOND), ['the second transcript'], SECOND)
  store = openStore()
})

afterEach(async () => {
  resetTranscriptConsumersForTests()
  store.close()
  await harness.cleanup()
})

function transcript(sessionId: string): string {
  return join(harness.claudeProjectDir, `${sessionId}.jsonl`)
}

function openStore(): SessionSearchStore {
  const opened = new SessionSearchStore(harness.databasePath, (error) => errors.push(error))
  registerSessionSearchIndexConsumer(opened)
  return opened
}

async function candidates() {
  return (
    await discoverSessionSearchCandidates(harness.roots, {
      limitPerAgent: Number.POSITIVE_INFINITY
    })
  ).candidates
}

it('re-reads nothing it already holds, even with a cold session-list cache', async () => {
  const first = await runSessionSearchIndexPass(store, await candidates())
  expect(first.stats.fullParses).toBe(2)

  // A restart: the parse cache is gone, the index's `files` table is not.
  store.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  store = openStore()

  const second = await runSessionSearchIndexPass(store, await candidates())
  expect(second.stats).toMatchObject({ fullParses: 0, incremental: 0, reused: 0, bytesRead: 0 })
  expect(errors).toEqual([])
})

it('resumes into a grown transcript instead of re-reading it whole', async () => {
  await runSessionSearchIndexPass(store, await candidates())
  await appendFile(transcript(FIRST), `${claudeLines(['a later turn'], FIRST, 10).join('\n')}\n`)

  const second = await runSessionSearchIndexPass(store, await candidates())
  expect(second.stats).toMatchObject({ incremental: 1, fullParses: 0 })
})

it('hands back everything the allowance had no room for, in order', async () => {
  const allowance = new SessionSearchCycleAllowance({ files: 1, bytes: 1_000_000 })
  const all = await candidates()
  const pass = await runSessionSearchIndexPass(store, all, { allowance })

  expect(pass.deferred.map((one) => one.file.path)).toEqual(
    all.slice(1).map((one) => one.file.path)
  )
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 1
  })
})

it('skips a source the reader cannot even open without failing the pass', async () => {
  const all = await candidates()
  await rm(transcript(FIRST))
  const pass = await runSessionSearchIndexPass(store, all)
  expect(pass.deferred).toEqual([])
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 1
  })
})

// Finding 6: mtime alone is not the freshness key. A transcript that grows
// while keeping its mtime (a same-second append, a restored timestamp) is a
// different file to the index, and reading only mtime would skip it forever.
it('re-reads a file that grew without its mtime moving', async () => {
  const path = transcript(FIRST)
  // A whole-millisecond stamp, so restoring it later reproduces it exactly.
  const frozen = new Date(1_740_000_000_000)
  await utimes(path, frozen, frozen)
  await runSessionSearchIndexPass(store, await candidates())

  await appendFile(path, `${claudeLines(['a same-mtime append'], FIRST, 20).join('\n')}\n`)
  await utimes(path, frozen, frozen)
  expect((await stat(path)).mtimeMs).toBe(frozen.getTime())

  const second = await runSessionSearchIndexPass(store, await candidates())
  expect(second.stats.fullParses + second.stats.incremental).toBe(1)
})

// Finding 5: the decision reads the session list's cache and then changes it,
// so outside the per-path lane an overlapping list parse stores its entry in
// between and the forced read degrades into a reuse.
it('is not overtaken by a list parse racing the same path', async () => {
  const path = transcript(FIRST)
  const all = await candidates()
  const only = all.filter((candidate) => candidate.file.path === path)

  // The list parses this path first, so its cursor covers the file, and again
  // concurrently with the index's pass so the two interleave.
  await parseTranscript(path)
  const [, pass] = await Promise.all([
    parseTranscript(path),
    runSessionSearchIndexPass(store, only)
  ])

  expect(pass.deferred).toEqual([])
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 1
  })
})

// Finding 4d: a declined read is a parse that returns normally and indexes
// nothing. Counting it makes a status claim files the index does not hold.
it('does not count a read the index declined, even though the parse succeeded', async () => {
  const only = (await candidates()).slice(0, 1)
  const indexed: string[] = []
  // What a WAL-budget refusal or a store that stopped accepting looks like from
  // the consumer's side: the read runs, and nothing is written.
  store.beginWrite = () => null

  const pass = await runSessionSearchIndexPass(store, only, {
    onIndexed: (candidate) => indexed.push(candidate.file.path)
  })

  expect(pass.stats.fullParses).toBe(1)
  expect(indexed).toEqual([])
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 0
  })
  // Declined, not forgotten: the store records it for a later whole re-read.
  expect(store.takeStale()).toHaveLength(1)
})
