import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './parse-cache/session-parse-cache-persistence'
import { resetSessionParseCacheForTests } from './parse-cache/session-parse-cache-store'
import { scanAiVaultSessions } from './session-scanner'
import SyncDatabase from '../sqlite/sync-database'
import { SessionParseCacheDatabase } from './parse-cache/session-parse-cache-database'
import { parseAgentSessionFileCached } from './parse-cache/session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

it.each([false, true])('keeps cold authority with read failure=%s', async (failReads) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-invalid-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const persistence = { filePath: join(root, 'parse-cache.json'), appVersion: 'test' }
  initSessionParseCachePersistence(persistence)
  const paths: string[] = []
  for (let index = 0; index < 8; index++) {
    const path = await writeRollout(
      roots.codexSessionsDir,
      `old-${index}`,
      index === 0 ? '/elsewhere' : '/repo',
      index + 1
    )
    if (index === 0) {
      const context = jsonLines([{ type: 'turn_context', payload: { cwd: '/repo' } }])
      const { atime, mtime } = await stat(path)
      await appendFile(path, `\n${context}\n`)
      await utimes(path, atime, mtime)
    }
    const { mtimeMs, size: sizeBytes, mtime } = await stat(path)
    const parsed = await parseAgentSessionFileCached(
      {
        agent: 'codex',
        file: { path, mtimeMs, sizeBytes, modifiedAt: mtime.toISOString() },
        codexHome: null
      },
      'linux'
    )
    expect(parsed?.cwd).toBe('/repo')
    paths.push(path)
  }
  await flushSessionParseCachePersist()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  const db = new SyncDatabase(join(root, 'session-parse-cache.sqlite'))
  for (const [index, session] of ['{', '1', '[]', 'true', '"scalar"', 'null', 'null'].entries()) {
    db.prepare('UPDATE rows SET session = ?, sidecar = ? WHERE path = ?').run(
      session,
      index === 5 ? '{' : null,
      paths[index + 1]
    )
  }
  db.prepare(
    'INSERT INTO scope_cwds SELECT path, mtime_ms, size_bytes, platform, ?, ?, seen_at FROM rows WHERE path = ?'
  ).run('{', '/elsewhere', paths[0])
  db.close()
  for (let index = 0; index < 9; index++) {
    await writeRollout(roots.codexSessionsDir, `busy-${index}`, '/other', 20)
  }
  initSessionParseCachePersistence(persistence)
  const metadata = vi.spyOn(SessionParseCacheDatabase.prototype, 'readScopeCwds')
  const ordinary = vi.spyOn(SessionParseCacheDatabase.prototype, 'read')
  const prepare = SyncDatabase.prototype.prepare
  const queries = vi.spyOn(SyncDatabase.prototype, 'prepare').mockImplementation(function (
    this: SyncDatabase,
    sql
  ) {
    if (failReads && sql.startsWith('SELECT') && sql.includes('FROM rows WHERE path')) {
      throw new Error('unavailable parsed channel')
    }
    return prepare.call(this, sql)
  })
  const result = await scanAiVaultSessions({
    ...roots,
    platform: 'linux',
    limit: 8,
    scopePaths: ['/repo']
  })
  expect(
    result.sessions
      .filter((row) => row.cwd === '/repo')
      .map((row) => row.filePath)
      .sort()
  ).toEqual(paths.slice(0, failReads ? 8 : 7).sort())
  expect(
    metadata.mock.calls.filter(([batch]) => batch.some((path) => paths.includes(path)))
  ).toHaveLength(1)
  expect(queries.mock.calls.filter(([sql]) => sql.includes('WHERE path IN'))).toHaveLength(2)
  if (failReads) {
    expect(ordinary.mock.calls.filter(([path]) => paths.includes(path))).toEqual([])
  }
})

async function writeRollout(sessionsDir: string, id: string, cwd: string, day: number) {
  const timestamp = new Date(Date.UTC(2026, 9, day, 10))
  const dir = join(sessionsDir, '2026', '10', String(day).padStart(2, '0'))
  const path = join(dir, `rollout-2026-10-${String(day).padStart(2, '0')}T10-00-00-${id}.jsonl`)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path,
    jsonLines([
      { timestamp, type: 'session_meta', payload: { id, cwd } },
      {
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: id }] }
      }
    ])
  )
  await utimes(path, timestamp, timestamp)
  return path
}
