import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { SessionSearchStore } from './session-search-store'
import { openSessionSearchDatabase } from './session-search-schema'
import { parseSearchCandidates } from './session-search-parse-candidates'
import {
  userRecord,
  assistantRecord,
  sessionCandidate,
  codexRolloutLines,
  CODEX_SESSION_ID,
  CODEX_ROLLOUT_FILE
} from './session-search-transcript-fixtures'
import { resetCodexSessionIndexTitleCacheForTests } from '../ai-vault/session-scanner-codex-title-index'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests,
  seedSessionParseCache
} from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import type { SessionFileCandidate } from '../ai-vault/session-scanner-types'

vi.mock('./session-search-backfill-pacing', () => ({ pauseBackfill: async () => {} }))
let directory: string | undefined
let databasePath = ''
let store: SessionSearchStore | undefined
let reader: SyncDatabase | undefined

/** The store keeps its connection private; row assertions read the same file separately. */
function rows(sql: string, ...values: unknown[]): unknown[] {
  reader ??= new SyncDatabase(databasePath, { readonly: true })
  return reader.prepare(sql).all(...(values as never[]))
}

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  reader?.close()
  reader = undefined
  store?.close()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'search-durable-reuse-'))
  const path = join(directory, 'session.jsonl')
  await writeFile(
    path,
    `${userRecord(0, 'ordinary title')}\n${assistantRecord(1, 'durableneedle')}\n`
  )
  const candidate = await candidateAt(path)
  databasePath = join(directory, 'index.sqlite')
  store = new SessionSearchStore(databasePath)
  registerSessionSearchIndexSink(store)
  await parseSearchCandidates(store, [candidate])
  store.close()
  resetSessionParseCacheForTests()
  store = new SessionSearchStore(databasePath)
  registerSessionSearchIndexSink(store)
  return { candidate, store }
}

async function candidateAt(path: string): Promise<SessionFileCandidate> {
  const file = await stat(path)
  return {
    agent: 'claude',
    codexHome: null,
    file: {
      path,
      mtimeMs: file.mtimeMs,
      modifiedAt: file.mtime.toISOString(),
      sizeBytes: file.size,
      dev: file.dev,
      ino: file.ino
    }
  }
}

it('reuses an unchanged reopened index without a preview cache or replacement write', async () => {
  const { candidate, store } = await fixture()
  const apply = vi.spyOn(store, 'apply')
  const fileRow = 'SELECT session_row_id FROM files WHERE path=?'
  const before = rows(fileRow, candidate.file.path)
  await parseSearchCandidates(store, [candidate])
  expect(apply).not.toHaveBeenCalled()
  expect(rows(fileRow, candidate.file.path)).toEqual(before)
  expect(store.search({ query: 'durableneedle' }).hits).toHaveLength(1)
  // Listing still needs its preview, even when backfill can reuse the index.
  expect(
    (await parseAgentSessionFileCached(candidate, process.platform))?.previewMessages.length
  ).toBeGreaterThan(0)
})

it('does not skip a changed or atomically replaced transcript', async () => {
  const { candidate, store } = await fixture()
  const apply = vi.spyOn(store, 'apply')
  await writeFile(candidate.file.path, `${userRecord(0, 'newlongerneedle')}\n`)
  await parseSearchCandidates(store, [await candidateAt(candidate.file.path)])
  expect(apply).toHaveBeenCalledOnce()
  resetSessionParseCacheForTests()
  const replacement = await candidateAt(candidate.file.path)
  replacement.file.ino = (replacement.file.ino ?? 0) + 1
  await parseSearchCandidates(store, [replacement])
  expect(apply).toHaveBeenCalledTimes(2)
})

it('keeps durable reuse beyond the 4096-entry preview cache', async () => {
  directory = await mkdtemp(join(tmpdir(), 'search-durable-cache-'))
  databasePath = join(directory, 'index.sqlite')
  const seedConnection = openSessionSearchDatabase(databasePath)
  store = new SessionSearchStore(databasePath)
  registerSessionSearchIndexSink(store)
  const now = Date.now()
  const candidates: SessionFileCandidate[] = Array.from({ length: 4097 }, (_, i) => ({
    agent: 'claude',
    codexHome: null,
    file: {
      path: `isolated-${i}`,
      mtimeMs: now,
      modifiedAt: new Date(now).toISOString(),
      sizeBytes: 1,
      dev: 1,
      ino: i + 1
    }
  }))
  seedConnection.exec('BEGIN')
  const insert = seedConnection.prepare(
    'INSERT INTO files(path,dev,ino,mtime_ms,size_bytes,byte_offset) VALUES(?,?,?,?,?,?)'
  )
  for (const { file } of candidates) {
    insert.run(file.path, file.dev!, file.ino!, now, 1, 1)
  }
  seedConnection.exec('COMMIT')
  seedConnection.close()
  seedSessionParseCache(
    candidates.map(({ file }) => [
      file.path,
      { mtimeMs: now, sizeBytes: 1, platform: process.platform, session: null }
    ])
  )
  const apply = vi.spyOn(store, 'apply')
  await parseSearchCandidates(store, candidates)
  expect(apply).not.toHaveBeenCalled()
  expect(store.coverage().providers.every((provider) => !provider.parseFailures)).toBe(true)
})

it('refreshes external Codex titles on cold reuse without replacing transcript rows', async () => {
  directory = await mkdtemp(join(tmpdir(), 'search-durable-title-'))
  const path = join(directory, CODEX_ROLLOUT_FILE)
  await writeFile(path, `${codexRolloutLines(['echo'], 'output', 'titleneedle').join('\n')}\n`)
  const candidate = await sessionCandidate('codex', path, directory)
  databasePath = join(directory, 'index.sqlite')
  store = new SessionSearchStore(databasePath)
  registerSessionSearchIndexSink(store)
  await parseSearchCandidates(store, [candidate])
  const readyRows = 'SELECT id FROM sessions WHERE index_ready = 1'
  const before = rows(readyRows)
  reader?.close()
  reader = undefined
  store.close()
  resetSessionParseCacheForTests()
  resetCodexSessionIndexTitleCacheForTests()
  store = new SessionSearchStore(databasePath)
  registerSessionSearchIndexSink(store)
  await writeFile(
    join(directory, 'session_index.jsonl'),
    `${JSON.stringify({
      id: CODEX_SESSION_ID,
      thread_name: 'Renamed durable title'
    })}\n`
  )
  const apply = vi.spyOn(store, 'apply')
  await parseSearchCandidates(store, [candidate])
  expect(store.search({ query: 'titleneedle' }).hits[0].title).toBe('Renamed durable title')
  expect(apply).not.toHaveBeenCalled()
  expect(rows(readyRows)).toEqual(before)
})
