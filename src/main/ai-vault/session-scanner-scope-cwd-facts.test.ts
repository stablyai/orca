import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as WslTranscriptFsAccess from '../native-chat/wsl-transcript-fs-access'
import { grokEncodedCwdDirName } from '../../shared/grok-session-paths'
import {
  flushSessionParseCachePersist,
  initSessionParseCachePersistence,
  resetSessionParseCachePersistenceForTests
} from './session-parse-cache-persistence'
import { resetSessionParseCacheForTests } from './session-parse-cache-store'
import { scanAiVaultSessions } from './session-scanner'
import SyncDatabase from '../sqlite/sync-database'
import { SessionParseCacheDatabase } from './session-parse-cache-database'
import { parseAgentSessionFileCached } from './session-scanner-parse-cache'
import { isolatedScanRoots, jsonLines } from './session-scanner-test-fixtures'

const reads = vi.hoisted((): string[] => [])
vi.mock('../native-chat/wsl-transcript-fs-access', async (importOriginal) => {
  const actual = await importOriginal<typeof WslTranscriptFsAccess>()
  return {
    ...actual,
    wslGatedReadFile: (...args: Parameters<typeof actual.wslGatedReadFile>) => {
      reads.push(String(args[0]))
      return actual.wslGatedReadFile(...args)
    },
    readTranscriptSlice: (...args: Parameters<typeof actual.readTranscriptSlice>) => {
      reads.push(String(args[0]))
      return actual.readTranscriptSlice(...args)
    },
    openTranscriptReadStream: (...args: Parameters<typeof actual.openTranscriptReadStream>) => {
      reads.push(String(args[0]))
      return actual.openTranscriptReadStream(...args)
    }
  }
})

let tempRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
  reads.length = 0
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
      await appendFile(path, `\n${context}\n`)
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

async function writeGrokSession(sessionsDir: string, id: string, cwd: string, day: number) {
  const dir = join(sessionsDir, grokEncodedCwdDirName(cwd) ?? 'unknown', id)
  await mkdir(dir, { recursive: true })
  const timestamp = new Date(Date.UTC(2026, 9, day, 10))
  const summary = join(dir, 'summary.json')
  await writeFile(
    summary,
    JSON.stringify({
      info: { id, cwd },
      created_at: timestamp.toISOString(),
      updated_at: timestamp.toISOString()
    })
  )
  await writeFile(join(dir, 'chat_history.jsonl'), jsonLines([{ type: 'user', content: id }]))
  await utimes(summary, timestamp, timestamp)
  return dir
}

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

it('settles out-of-scope transcripts once and reads none of them after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-scope-cwd-facts-'))
  tempRoots.push(root)
  const roots = isolatedScanRoots(root)
  const persistence = { filePath: join(root, 'user-data', 'parse-cache.json'), appVersion: 'test' }
  initSessionParseCachePersistence(persistence)
  const others: string[] = []
  for (const day of [15, 14, 13]) {
    others.push(await writeGrokSession(roots.grokSessionsDir, `other-${day}`, '/other', day))
  }
  const quiet = await writeGrokSession(roots.grokSessionsDir, 'repo-1', '/repo', 1)
  const elsewhere = await writeRollout(roots.codexSessionsDir, 'other-2', '/other', 2)
  const scan = () =>
    scanAiVaultSessions({ ...roots, platform: 'linux', limit: 1, scopePaths: ['/repo'] })

  const listed = (await scan()).sessions.map((session) => session.cwd)
  expect(listed.filter((cwd) => cwd === '/repo')).toHaveLength(1)
  // The walked Grok session was ruled out from summary.json, never its history.
  expect(reads).not.toContain(join(others[2], 'chat_history.jsonl'))

  await flushSessionParseCachePersist()
  resetSessionParseCachePersistenceForTests()
  resetSessionParseCacheForTests()
  initSessionParseCachePersistence(persistence)
  reads.length = 0

  const relisted = (await scan()).sessions.filter((session) => session.cwd === '/repo')
  expect(relisted.map((session) => session.filePath)).toEqual([join(quiet, 'summary.json')])
  expect(reads.filter((path) => path.startsWith(root))).toEqual([])
  expect(reads).not.toContain(elsewhere)
})
