import './worker/session-search-worker.test-fixture'
import { existsSync } from 'node:fs'
import { unlink, utimes } from 'node:fs/promises'
import * as fileRemoval from '../../shared/windows-transient-lock-removal'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resetSessionParseCacheForTests } from '../ai-vault/parse-cache/session-parse-cache-store'
import { resetTranscriptConsumersForTests } from '../ai-vault/transcripts/session-transcript-consumers'
import './storage/session-search-schema'
import './worker/session-search-readers'
import { SessionSearchInstance } from './session-search-instance'
import { SessionSearchIndexer } from './indexing/session-search-indexer'
import {
  openSessionSearchIndexerHarness,
  writeClaudeTranscript,
  type SessionSearchIndexerHarness
} from './indexing/session-search-indexer-test-fixture'

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
  await instance?.close()
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
  expect(await subject.status()).toMatchObject({ enabled: false, phase: 'idle', generation: 0 })
  expect(errors).toEqual([])
})

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

  subject.apply({ enabled: true, historyDays: 30 })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([])
  expect(await searchFor('recent')).toEqual([RECENT_SESSION_ID])

  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  expect(await searchFor('ancient')).toEqual([ANCIENT_SESSION_ID])
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

  await subject.clear()
  expect(subject.running).toBe(true)
  expect(existsSync(harness.databasePath)).toBe(true)
  await subject.settled()
  expect(await searchFor('distinctive')).toEqual([RECENT_SESSION_ID])

  subject.apply({ enabled: false, historyDays: null })
  await subject.clear()
  expect(subject.running).toBe(false)
  expect(existsSync(harness.databasePath)).toBe(false)
  expect(errors).toEqual([])
})

it('never reports the deleted index while re-enabling a cleared search', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), ['searchable conversation'], id)
  }
  const subject = newInstance()
  const initialEnable = subject.apply({ enabled: true, historyDays: null })
  expect(await subject.status()).toMatchObject({
    enabled: true,
    phase: 'indexing',
    filesIndexed: 0,
    messagesIndexed: 0
  })
  await initialEnable
  await subject.settled()
  expect(await subject.status()).toMatchObject({ filesIndexed: 2, messagesIndexed: 4 })

  await subject.apply({ enabled: false, historyDays: null })
  await subject.clear()
  expect(existsSync(harness.databasePath)).toBe(false)
  await unlink(transcriptPath(ANCIENT_SESSION_ID))

  let release!: () => void
  let opening!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const started = new Promise<void>((resolve) => {
    opening = resolve
  })
  const initialize = SessionSearchIndexer.prototype.initialize
  vi.spyOn(SessionSearchIndexer.prototype, 'initialize').mockImplementationOnce(async function (
    this: SessionSearchIndexer
  ) {
    opening()
    await blocked
    await initialize.call(this)
  })
  const enabling = subject.apply({ enabled: true, historyDays: null })
  try {
    await started
    expect(await subject.status()).toMatchObject({
      enabled: true,
      phase: 'indexing',
      filesIndexed: 0,
      messagesIndexed: 0
    })
  } finally {
    release()
    await enabling
  }
  await subject.settled()
  expect(await subject.status()).toMatchObject({ filesIndexed: 1, messagesIndexed: 2 })
  expect(errors).toEqual([])
})

it('refuses a page cursor minted before clear even when the rebuilt generation matches', async () => {
  for (const id of [RECENT_SESSION_ID, ANCIENT_SESSION_ID]) {
    await writeClaudeTranscript(transcriptPath(id), [`shared clear fence ${id}`], id)
  }
  const subject = newInstance()
  subject.apply({ enabled: true, historyDays: null })
  await subject.settled()
  const first = await subject.search({ query: 'shared clear fence', limit: 1 })
  if (first.kind !== 'results' || !first.page.cursor) {
    throw new Error('expected a paged result')
  }

  await subject.clear()
  await subject.settled()
  expect((await subject.status()).generation).toBe(first.generation)
  expect(
    await subject.search({ query: 'shared clear fence', limit: 1, cursor: first.page.cursor })
  ).toMatchObject({ kind: 'stale-cursor', generation: first.generation })
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

it('keeps serving while an asynchronous clear deletion outlives its deadline', async () => {
  const subject = newInstance()
  let reject!: (error: Error) => void
  const blocked = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  const remove = vi.spyOn(fileRemoval, 'removeTree').mockReturnValue(blocked)
  vi.useFakeTimers()
  try {
    const clear = expect(subject.clear()).rejects.toThrow('Could not complete')
    await vi.advanceTimersByTimeAsync(0)
    expect(remove).toHaveBeenCalled()
    expect(await subject.status()).toMatchObject({ enabled: false })
    await vi.advanceTimersByTimeAsync(10_000)
    await clear
    expect(await subject.search({ query: 'responsive' })).toMatchObject({ reason: 'disabled' })
    reject(new Error('file remains locked'))
    await subject.close()
    expect(errors).toContainEqual(new Error('file remains locked'))
  } finally {
    vi.useRealTimers()
    remove.mockRestore()
  }
})
