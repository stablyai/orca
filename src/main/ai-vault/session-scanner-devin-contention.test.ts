import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import SyncDatabase from '../sqlite/sync-database'
import { scanAiVaultSessions } from './session-scanner'
import { resetDevinSessionsIndexCacheForTests } from './session-scanner-devin-db'
import * as databaseReader from './session-scanner-opencode-sqlite-open'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  resetSessionParseCacheForTests()
  resetDevinSessionsIndexCacheForTests()
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

it('attempts a contended index once per scan and enriches all transcripts after recovery', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-devin-contention-'))
  const roots = isolatedScanRoots(root)
  await mkdir(roots.devinTranscriptsDir, { recursive: true })
  const db = new SyncDatabase(join(root, 'sessions.db'))
  const cwd = join(root, 'workspace')
  try {
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT)')
    for (const id of ['one', 'two', 'three']) {
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(id, cwd)
      await writeFile(
        join(roots.devinTranscriptsDir, `${id}.json`),
        JSON.stringify({ session_id: id, steps: [{ source: 'user', message: `Task ${id}` }] })
      )
    }
  } finally {
    db.close()
  }
  const reader = vi.spyOn(databaseReader, 'readOpenCodeDatabase').mockImplementation(() => {
    throw new Error('SQLITE_BUSY')
  })
  const first = await scanAiVaultSessions({ ...roots, unlimited: true })
  expect(first.sessions).toHaveLength(3)
  expect(first.sessions.every((session) => session.cwd === null)).toBe(true)
  expect(reader).toHaveBeenCalledTimes(1)

  reader.mockRestore()
  const recoveredReader = vi.spyOn(databaseReader, 'readOpenCodeDatabase')
  const recovered = await scanAiVaultSessions({ ...roots, unlimited: true })
  expect(recovered.sessions).toHaveLength(3)
  expect(recovered.sessions.every((session) => session.cwd === cwd)).toBe(true)
  expect(recoveredReader).toHaveBeenCalledTimes(1)
})
