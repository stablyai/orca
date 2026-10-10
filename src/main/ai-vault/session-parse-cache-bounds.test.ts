import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureValidator
} from '../../shared/json-text-structure-limit'
import {
  ensureSessionParseCacheLoaded,
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests,
  scheduleSessionParseCachePersist
} from './session-parse-cache-persistence'
import {
  getSessionParseCacheEntry,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  storeSessionParseCacheEntry,
  type PersistedSessionParseCacheEntry
} from './session-parse-cache-store'
import {
  SESSION_PARSE_CACHE_JSON_LIMITS,
  SESSION_PARSE_CACHE_MAX_BYTES,
  SESSION_PARSE_CACHE_SCHEMA_VERSION,
  serializeSessionParseCacheSnapshotPiecesCooperatively
} from './session-parse-cache-snapshot-serialization'

let root: string
let file: string
const entry = (mtimeMs: number): PersistedSessionParseCacheEntry => ({
  mtimeMs,
  sizeBytes: null,
  platform: 'darwin',
  session: null
})
const row = (path: string, mtimeMs: number): [string, PersistedSessionParseCacheEntry] => [
  path,
  entry(mtimeMs)
]
const stats = { reused: 0, fullParses: 1, incremental: 0, earlyStopped: 0, bytesRead: 0 }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-cache-bounds-'))
  file = join(root, 'cache.json')
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  initSessionParseCachePersistence({ filePath: file, appVersion: 'new-release' })
})
afterEach(async () => {
  resetSessionParseCachePersistenceForTests()
  await rm(root, { recursive: true, force: true })
})

it('loads the newest 4096 unique rows across duplicate-heavy input and keeps in-process entries', async () => {
  const entries = Array.from({ length: 4200 }, (_, index) => row(`p${index}`, index))
  entries.push(...Array.from({ length: 5000 }, (_, index) => row('p4199', 5000 + index)))
  entries.push(row('in-process', 1))
  seedSessionParseCache([row('in-process', 20_000)])
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION,
      appVersion: 'old-release',
      entries
    })
  )
  await ensureSessionParseCacheLoaded()
  expect(snapshotSessionParseCacheForPersistence()).toHaveLength(4096)
  expect(getSessionParseCacheEntry('p4199')?.mtimeMs).toBe(9999)
  expect(getSessionParseCacheEntry('p104')).toBeUndefined()
  expect(getSessionParseCacheEntry('p105')?.mtimeMs).toBe(105)
  expect(getSessionParseCacheEntry('in-process')?.mtimeMs).toBe(20_000)
})

it('seeds newest unique rows directly without retaining an unbounded iterable', () => {
  function* entries() {
    for (let index = 0; index < 5000; index++) {
      yield row(`p${index}`, index)
    }
    yield row('p4999', 6000)
  }
  seedSessionParseCache(entries())
  expect(snapshotSessionParseCacheForPersistence()).toHaveLength(4096)
  expect(getSessionParseCacheEntry('p903')).toBeUndefined()
  expect(getSessionParseCacheEntry('p904')?.mtimeMs).toBe(904)
  expect(getSessionParseCacheEntry('p4999')?.mtimeMs).toBe(6000)
})

it('rejects an oversized sparse file before decoding and preserves resident work', async () => {
  seedSessionParseCache([row('resident', 3)])
  const handle = await open(file, 'w')
  await handle.truncate(SESSION_PARSE_CACHE_MAX_BYTES + 1)
  await handle.close()
  await ensureSessionParseCacheLoaded()
  expect(snapshotSessionParseCacheForPersistence().map(([path]) => path)).toEqual(['resident'])
})

it('rejects excessive tokens, depth, and malformed older rows before seeding any tail', async () => {
  for (const raw of [
    `{"schemaVersion":${SESSION_PARSE_CACHE_SCHEMA_VERSION},"appVersion":"old","entries":[],"wide":[${'0,'.repeat(1_000_000)}0]}`,
    `{"schemaVersion":${SESSION_PARSE_CACHE_SCHEMA_VERSION},"appVersion":"old","entries":[],"deep":${'['.repeat(33)}0${']'.repeat(33)}}`,
    JSON.stringify({
      schemaVersion: SESSION_PARSE_CACHE_SCHEMA_VERSION,
      appVersion: 'old',
      entries: [['bad', {}], ...Array.from({ length: 4200 }, (_, index) => row(`p${index}`, index))]
    })
  ]) {
    await writeFile(file, raw)
    resetSessionParseCachePersistenceForTests()
    initSessionParseCachePersistence({ filePath: file, appVersion: 'new' })
    await ensureSessionParseCacheLoaded()
    expect(snapshotSessionParseCacheForPersistence()).toEqual([])
  }
})

it('retains a valid newest suffix under both byte and structural capacity', async () => {
  const entries = Array.from({ length: 40 }, (_, index) => row(`p${index}`, index))
  const snapshot = await serializeSessionParseCacheSnapshotPiecesCooperatively(
    entries,
    'release',
    700,
    { structuralTokens: 120, nestingDepth: 32 }
  )
  expect(snapshot).not.toBeNull()
  const serialized = snapshot!.pieces.join('')
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(700)
  assertJsonTextStructureWithinLimits(serialized, { structuralTokens: 120, nestingDepth: 32 })
  expect(JSON.parse(serialized).entries).toEqual(entries.slice(-snapshot!.retainedEntries))
  expect(snapshot!.retainedEntries).toBeGreaterThan(0)
  expect(snapshot!.retainedEntries).toBeLessThan(entries.length)
})

it('keeps the previous atomic snapshot when its newest row cannot fit', async () => {
  seedSessionParseCache([row('valid', 1)])
  scheduleSessionParseCachePersist(stats)
  await flushSessionParseCachePersist()
  const previous = await readFile(file, 'utf8')
  const session: AiVaultSession = {
    id: 'local:claude:newest',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'newest',
    title: 'newest',
    cwd: null,
    branch: null,
    model: null,
    filePath: 'newest',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: new Date(0).toISOString(),
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: '',
    subagent: null
  }
  let deep: unknown = null
  for (let index = 0; index < 35; index++) {
    deep = { nested: deep }
  }
  Reflect.set(session, 'syntheticDeepField', deep)
  storeSessionParseCacheEntry('newest', { ...entry(2), session, resume: null })
  scheduleSessionParseCachePersist(stats)
  await flushSessionParseCachePersist()
  expect(await readFile(file, 'utf8')).toBe(previous)
})

it('preserves escape state at every chunk boundary while ignoring punctuation inside strings', () => {
  const content = JSON.stringify({
    nested: ['[\\\\\"{}:,]', '\\', 'end\\', { value: 'x'.repeat(300_000) }]
  })
  for (const size of [1, 2, 3, 17, 256 * 1024]) {
    const validator = new JsonTextStructureValidator(SESSION_PARSE_CACHE_JSON_LIMITS)
    for (let start = 0; start < content.length; start += size) {
      validator.consume(content.slice(start, start + size))
    }
    expect(validator.usage()).toEqual({ structuralTokens: 11, nestingDepth: 3 })
  }
})

it('yields while escaping a large Unicode string and preserves surrogate pairs', async () => {
  const path = '😀"\\\n'.repeat(100_000)
  let progressed = false
  setImmediate(() => {
    progressed = true
  })
  const snapshot = await serializeSessionParseCacheSnapshotPiecesCooperatively(
    [row(path, 1)],
    'release'
  )
  expect(progressed).toBe(true)
  expect(JSON.parse(snapshot!.pieces.join('')).entries).toEqual([row(path, 1)])
})
