import { existsSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { resetTranscriptConsumersForTests } from '../ai-vault/session-transcript-consumers'
import { SessionSearchInstance } from './session-search-instance'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './session-search-indexer-test-fixture'

const RECENT_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const ANCIENT_SESSION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'

let harness: SessionSearchIndexerHarness
let instance: SessionSearchInstance | null
let errors: unknown[]

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetTranscriptConsumersForTests()
  errors = []
  harness = await openSessionSearchIndexerHarness('ss-instance')
  instance = null
})

afterEach(async () => {
  vi.restoreAllMocks()
  instance?.close()
  resetTranscriptConsumersForTests()
  resetSessionParseCacheForTests()
  await harness.cleanup()
})

function newInstance(): SessionSearchInstance {
  instance = new SessionSearchInstance({
    databasePath: harness.databasePath,
    roots: harness.roots,
    onError: (error) => errors.push(error)
  })
  return instance
}

function transcriptPath(sessionId: string): string {
  return join(harness.claudeProjectDir, `${sessionId}.jsonl`)
}

async function searchFor(query: string): Promise<string[]> {
  const response = await instance!.search({ query })
  if (response.kind !== 'results') {
    throw new Error(`expected results, got ${response.kind}`)
  }
  return response.hits.map((hit) => hit.sessionId).sort()
}

it('constructs nothing and touches no disk while the setting is off', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ enabled: false, historyDays: null })
  await subject.settled()

  expect(subject.running).toBe(false)
  expect(existsSync(harness.databasePath)).toBe(false)
  expect(await subject.search({ query: 'conversation' })).toEqual({
    kind: 'unavailable',
    reason: 'disabled'
  })
  expect(subject.status()).toMatchObject({ enabled: false, phase: 'idle', generation: 0 })
  expect(errors).toEqual([])
})

it('indexes and answers once the setting is on', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a distinctive conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()

  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])
  const status = subject.status()
  expect(status.enabled).toBe(true)
  expect(status.filesIndexed).toBeGreaterThan(0)
  expect(status.generation).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

// The whole reason the indexer is immutable: a change is a new instance, and the
// old one is closed before it exists, so there is never a second writer.
it('closes the live pair and starts a new one on a settings change', async () => {
  const recent = transcriptPath(RECENT_SESSION_ID)
  const ancient = transcriptPath(ANCIENT_SESSION_ID)
  await writeClaudeTranscript(recent, ['a recent conversation'], RECENT_SESSION_ID)
  await writeClaudeTranscript(ancient, ['an ancient conversation'], ANCIENT_SESSION_ID)
  const longAgo = new Date(Date.now() - 120 * 86_400_000)
  await utimes(ancient, longAgo, longAgo)

  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([ANCIENT_SESSION_ID])

  // Narrowing: the new instance's opening sweep purges what the window no longer covers.
  subject.apply({ enabled: true, historyDays: 30 })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([])
  expect(await searchFor('recent')).toEqual([RECENT_SESSION_ID])

  // Widening: the same recipe the other way, admitting files no read ever saw.
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([ANCIENT_SESSION_ID])
  expect(errors).toEqual([])
})

it('leaves nothing running and no live claim when the setting goes off', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(subject.running).toBe(true)

  subject.apply({ enabled: false, historyDays: null })
  expect(subject.running).toBe(false)
  // The index is left on disk: disabling is not a deletion, and the claim the
  // closed indexer staked on the path has to be released or nothing can reopen it.
  expect(existsSync(harness.databasePath)).toBe(true)
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(subject.running).toBe(true)
  expect(errors).toEqual([])
})

it('removes the database on clear and rebuilds only while consent stands', async () => {
  await writeClaudeTranscript(
    transcriptPath(RECENT_SESSION_ID),
    ['a distinctive conversation'],
    RECENT_SESSION_ID
  )
  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])

  subject.clear()
  expect(subject.running).toBe(true)
  expect(existsSync(harness.databasePath)).toBe(true)
  await subject.settled()
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])

  subject.apply({ enabled: false, historyDays: null })
  subject.clear()
  expect(subject.running).toBe(false)
  expect(existsSync(harness.databasePath)).toBe(false)
  expect(errors).toEqual([])
})

it('keeps pagination stable when the clock crosses retention before a purge', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), [`distinctive conversation ${id}`], id)
  }
  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: 30 })
  await subject.settled()
  const first = await subject.search({ query: 'distinctive', limit: 1 })
  if (first.kind !== 'results') {
    throw new Error('expected results')
  }
  expect(first.page.cursor).toBeTruthy()
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86_400_000)
  const second = await subject.search({
    query: 'distinctive',
    limit: 1,
    cursor: first.page.cursor!
  })
  if (second.kind !== 'results') {
    throw new Error('expected results')
  }
  expect(second.generation).toBe(first.generation)
  expect(second.hits).toHaveLength(1)
  expect(second.hits[0].sessionId).not.toBe(first.hits[0].sessionId)
  expect(errors).toEqual([])
})
