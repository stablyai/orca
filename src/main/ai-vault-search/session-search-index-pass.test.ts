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

/** What a pass hands the read loop: the store's rows, read once. */
function rows() {
  return new Map(store.files().map((row) => [row.path, row]))
}

function pass(options: { overdue?: () => boolean } = {}) {
  return runSessionSearchIndexPass(store, [], { rows: rows(), ...options })
}

async function passOverAll(options: { overdue?: () => boolean } = {}) {
  return runSessionSearchIndexPass(store, await candidates(), { rows: rows(), ...options })
}

function states(): Record<string, string> {
  return Object.fromEntries(store.files().map((row) => [row.path, row.state]))
}

it('re-reads nothing it already holds, even with a cold session-list cache', async () => {
  const first = await passOverAll()
  expect(first.stats.fullParses).toBe(2)

  // A restart: the parse cache is gone, the index's `files` table is not.
  store.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  store = openStore()

  const second = await passOverAll()
  expect(second.stats).toMatchObject({ fullParses: 0, incremental: 0, reused: 0, bytesRead: 0 })
  expect(errors).toEqual([])
})

it('resumes into a grown transcript instead of re-reading it whole', async () => {
  await passOverAll()
  await appendFile(transcript(FIRST), `${claudeLines(['a later turn'], FIRST, 10).join('\n')}\n`)

  const second = await passOverAll()
  expect(second.stats).toMatchObject({ incremental: 1, fullParses: 0 })
})

// Nothing is recorded about what a deadline cut off, because being owed is a
// fact about the row: the file is read on the next pass for the same reason it
// was owed on this one.
it('leaves what it ran out of time for owed, with nothing written down', async () => {
  const all = await candidates()
  const cut = await runSessionSearchIndexPass(store, all, { rows: rows(), overdue: () => true })

  expect(cut.outOfTime).toBe(true)
  expect(store.files()).toHaveLength(1)
  const second = await passOverAll()
  expect(second.stats.fullParses).toBe(1)
  expect(store.files()).toHaveLength(2)
})

// The deadline is never applied before the pass has read anything, so a single
// transcript larger than one deadline is read alone rather than starved.
it('reads one file even when the deadline has already expired', async () => {
  const only = (await candidates()).slice(0, 1)
  const alone = await runSessionSearchIndexPass(store, only, { rows: rows(), overdue: () => true })

  expect(alone.outOfTime).toBe(false)
  expect(store.files()).toHaveLength(1)
})

it('skips a source the reader cannot even open without failing the pass', async () => {
  const all = await candidates()
  await rm(transcript(FIRST))
  await runSessionSearchIndexPass(store, all, { rows: rows() })

  // One session indexed, and the missing one recorded as a failed read rather
  // than as content the index holds.
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 1
  })
  expect(states()[transcript(FIRST)]).toBe('failed')
})

// Finding 6: mtime alone is not the freshness key. A transcript that grows
// while keeping its mtime (a same-second append, a restored timestamp) is a
// different file to the index, and reading only mtime would skip it forever.
it('re-reads a file that grew without its mtime moving', async () => {
  const path = transcript(FIRST)
  // A whole-millisecond stamp, so restoring it later reproduces it exactly.
  const frozen = new Date(1_740_000_000_000)
  await utimes(path, frozen, frozen)
  await passOverAll()

  await appendFile(path, `${claudeLines(['a same-mtime append'], FIRST, 20).join('\n')}\n`)
  await utimes(path, frozen, frozen)
  expect((await stat(path)).mtimeMs).toBe(frozen.getTime())

  const second = await passOverAll()
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
  await Promise.all([
    parseTranscript(path),
    runSessionSearchIndexPass(store, only, { rows: rows() })
  ])

  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 1
  })
})

// Finding 4d: a declined read is a parse that returns normally and indexes
// nothing. It has to leave the row owing a read, not looking covered.
it('leaves a declined read owed rather than recorded as held', async () => {
  const only = (await candidates()).slice(0, 1)
  // What a store that refuses a write looks like from the consumer's side: the
  // read runs, and nothing is written.
  store.beginWrite = () => null

  const stats = await runSessionSearchIndexPass(store, only, { rows: rows() })

  expect(stats.stats.fullParses).toBe(1)
  expect(harness.read((db) => db.prepare('SELECT count(*) AS n FROM sessions').get())).toEqual({
    n: 0
  })
  expect(store.files()).toEqual([])
})

it('reads nothing when there is nothing to read', async () => {
  expect((await pass()).stats).toMatchObject({ fullParses: 0 })
})
