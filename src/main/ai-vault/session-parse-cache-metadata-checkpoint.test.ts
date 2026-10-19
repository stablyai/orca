import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import {
  createSessionParseStats,
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { getSessionParseCacheEntry } from './session-parse-cache-store'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import { CODEX_FIXTURE_SESSION_ID, codexFixture } from './session-scanner-codex-fixtures'
import { resetCursorChatMetaIndexCacheForTests } from './session-scanner-cursor-chat-meta'
import { writeJsonlFile } from './session-scanner-test-fixtures'
import type { SessionFileCandidate } from './session-scanner-types'

let root: string
let cacheFile: string
let write: MockInstance<SessionParseCacheDatabase['write']>

beforeEach(async () => {
  resetSessionParseCacheForTests()
  resetSessionParseCachePersistenceForTests()
  resetCursorChatMetaIndexCacheForTests()
  root = await mkdtemp(join(tmpdir(), 'orca-cache-metadata-checkpoint-'))
  cacheFile = join(root, 'cache.json')
  initSessionParseCachePersistence({ filePath: cacheFile, appVersion: 'test' })
  write = vi.spyOn(SessionParseCacheDatabase.prototype, 'write')
})

afterEach(async () => {
  await flushSessionParseCachePersist()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  resetCursorChatMetaIndexCacheForTests()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function candidate(
  agent: SessionFileCandidate['agent'],
  path: string,
  codexHome: string | null = null,
  sidecarPath?: string
): Promise<SessionFileCandidate> {
  const file = await stat(path)
  const sidecar = sidecarPath ? await stat(sidecarPath) : null
  return {
    agent,
    codexHome,
    file: {
      path,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.size,
      modifiedAt: file.mtime.toISOString(),
      ...(sidecar && sidecarPath
        ? { sidecar: { path: sidecarPath, mtimeMs: sidecar.mtimeMs, sizeBytes: sidecar.size } }
        : {})
    }
  }
}

function storedSession(path: string) {
  const database = new SessionParseCacheDatabase(join(root, 'session-parse-cache.sqlite'))
  try {
    return database.read(path)?.session
  } finally {
    database.close()
  }
}

it('persists a reused Codex title update without mutating the prior session and skips its next hit', async () => {
  const codexHome = join(root, 'codex')
  const fixture = codexFixture()
  const path = join(codexHome, 'sessions', fixture.fileName)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${fixture.seedLines.join('\n')}\n`)
  const first = await parseAgentSessionFileCached(
    await candidate('codex', path, codexHome),
    process.platform
  )
  await flushSessionParseCachePersist()
  await writeFile(
    join(codexHome, 'session_index.jsonl'),
    `${JSON.stringify({ id: CODEX_FIXTURE_SESSION_ID, thread_name: 'Indexed title' })}\n`
  )
  write.mockClear()
  const stats = createSessionParseStats()
  const updated = await parseAgentSessionFileCached(
    await candidate('codex', path, codexHome),
    process.platform,
    stats
  )
  await flushSessionParseCachePersist()
  expect(stats).toMatchObject({ reused: 1, fullParses: 0 })
  expect(first?.title).toBe('codex seed question')
  expect(updated?.title).toBe('Indexed title')
  expect(storedSession(path)?.title).toBe('Indexed title')
  expect(write).toHaveBeenCalledOnce()
  write.mockClear()
  expect(
    await parseAgentSessionFileCached(await candidate('codex', path, codexHome), process.platform)
  ).toBe(updated)
  await flushSessionParseCachePersist()
  expect(write).not.toHaveBeenCalled()
})

it('persists a reused subagent count update with immutable session replacement and skips the next hit', async () => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const path = join(root, `${id}.jsonl`)
  await writeFile(path, '')
  const first = await parseAgentSessionFileCached(await candidate('claude', path), process.platform)
  await flushSessionParseCachePersist()
  await writeJsonlFile(join(root, id, 'subagents', 'agent-a.jsonl'), [])
  write.mockClear()
  const stats = createSessionParseStats()
  const updated = await parseAgentSessionFileCached(
    await candidate('claude', path),
    process.platform,
    stats
  )
  await flushSessionParseCachePersist()
  expect(stats).toMatchObject({ reused: 1, fullParses: 0 })
  expect(first?.subagentTranscriptCount).toBe(0)
  expect(updated?.subagentTranscriptCount).toBe(1)
  expect(storedSession(path)?.subagentTranscriptCount).toBe(1)
  expect(write).toHaveBeenCalledOnce()
  write.mockClear()
  expect(await parseAgentSessionFileCached(await candidate('claude', path), process.platform)).toBe(
    updated
  )
  await flushSessionParseCachePersist()
  expect(write).not.toHaveBeenCalled()
})

it('persists metadata-only sidecar changes and retains identity across equivalent re-enrichment', async () => {
  const home = join(root, '.cursor')
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const path = join(home, 'projects', 'slug', 'agent-transcripts', id, `${id}.jsonl`)
  const metaPath = join(home, 'chats', 'workspace-hash', id, 'meta.json')
  await writeJsonlFile(path, [])
  await mkdir(dirname(metaPath), { recursive: true })
  const meta = { schemaVersion: 1, title: 'First', cwd: '/repo/first', hasConversation: true }
  await writeFile(metaPath, JSON.stringify(meta))
  const first = await parseAgentSessionFileCached(
    await candidate('cursor', path, null, metaPath),
    process.platform
  )
  const previousEntry = getSessionParseCacheEntry(path)
  await flushSessionParseCachePersist()
  await writeFile(metaPath, JSON.stringify({ ...meta, title: 'Second', cwd: '/repo/second' }))
  const future = new Date(Date.now() + 10_000)
  await utimes(metaPath, future, future)
  write.mockClear()
  const stats = createSessionParseStats()
  const current = await candidate('cursor', path, null, metaPath)
  const updated = await parseAgentSessionFileCached(current, process.platform, stats)
  await flushSessionParseCachePersist()
  expect(stats).toMatchObject({ reused: 1, fullParses: 0 })
  expect(first?.title).toBe('First')
  expect(previousEntry?.session?.title).toBe('First')
  expect(updated?.title).toBe('Second')
  expect(storedSession(path)?.cwd).toBe('/repo/second')
  expect(write).toHaveBeenCalledOnce()
  const uncertain = { ...current, file: { ...current.file, sidecar: 'unknown' as const } }
  expect(await parseAgentSessionFileCached(uncertain, process.platform)).toBe(updated)
  await flushSessionParseCachePersist()
  write.mockClear()
  expect(await parseAgentSessionFileCached(uncertain, process.platform)).toBe(updated)
  await flushSessionParseCachePersist()
  expect(write).not.toHaveBeenCalled()
})
