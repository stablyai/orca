import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const { beforeCopyMock } = vi.hoisted(() => ({ beforeCopyMock: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    copyFileSync: (...args: Parameters<typeof actual.copyFileSync>) => {
      beforeCopyMock(...args)
      return actual.copyFileSync(...args)
    }
  }
})

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'
import { createChromiumCookieSnapshot } from './chromium-cookie-snapshot'

function sourceFiles(databasePath: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>()
  for (const suffix of ['', '-wal', '-shm'] as const) {
    const path = databasePath + suffix
    if (existsSync(path)) {
      files.set(suffix, readFileSync(path))
    }
  }
  return files
}

function expectSourceFilesUnchanged(databasePath: string, before: Map<string, Buffer>): void {
  expect(sourceFiles(databasePath)).toEqual(before)
}

describe('createChromiumCookieSnapshot', () => {
  let root: string
  let writer: DatabaseSync | null

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-chromium-snapshot-test-'))
    writer = null
    beforeCopyMock.mockReset()
  })

  afterEach(() => {
    writer?.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('reads committed WAL-only rows without changing any live source file', () => {
    const sourcePath = join(root, 'Chrome', 'Default', 'Network', 'Cookies')
    writer = createChromiumCookieTestDatabase(
      sourcePath,
      [{ name: 'wal-session', value: 'fresh-value' }],
      { journalMode: 'wal' }
    )
    const before = sourceFiles(sourcePath)

    const snapshot = createChromiumCookieSnapshot(sourcePath, { tempRoot: root })
    const snapshotDir = dirname(snapshot.databasePath)
    const database = new DatabaseSync(snapshot.databasePath, { readOnly: true })
    const rows = database.prepare('SELECT name, value FROM cookies').all()
    database.close()

    expect(rows).toEqual([expect.objectContaining({ name: 'wal-session', value: 'fresh-value' })])
    expect(existsSync(`${snapshot.databasePath}-wal`)).toBe(true)
    expect(existsSync(`${snapshot.databasePath}-shm`)).toBe(true)
    expectSourceFilesUnchanged(sourcePath, before)

    snapshot.cleanup()
    expect(existsSync(snapshotDir)).toBe(false)
  })

  it('snapshots a database when WAL and SHM sidecars are absent', () => {
    const sourcePath = join(root, 'Chrome', 'Default', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, [
      { name: 'main-session', value: 'persisted-value' }
    ]).close()

    const snapshot = createChromiumCookieSnapshot(sourcePath, { tempRoot: root })
    const database = new DatabaseSync(snapshot.databasePath, { readOnly: true })
    const row = database.prepare('SELECT name, value FROM cookies').get()
    database.close()

    expect(row).toEqual(expect.objectContaining({ name: 'main-session', value: 'persisted-value' }))
    expect(existsSync(`${snapshot.databasePath}-wal`)).toBe(false)
    snapshot.cleanup()
  })

  it('retries when a WAL appears while the main database is being copied', () => {
    const sourcePath = join(root, 'Chrome', 'Default', 'Cookies')
    createChromiumCookieTestDatabase(sourcePath, []).close()
    beforeCopyMock.mockImplementationOnce((source: string) => {
      if (source === sourcePath) {
        writer = new DatabaseSync(sourcePath)
        writer.exec(
          "PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO cookies (creation_utc, host_key, name, value, path, expires_utc, is_secure, is_httponly, samesite) VALUES (1, '.example.com', 'raced-in', 'wal-value', '/', 0, 0, 0, 0)"
        )
      }
    })

    const snapshot = createChromiumCookieSnapshot(sourcePath, { tempRoot: root })
    const database = new DatabaseSync(snapshot.databasePath, { readOnly: true })
    const row = database.prepare("SELECT value FROM cookies WHERE name = 'raced-in'").get()
    database.close()

    expect(row).toEqual(expect.objectContaining({ value: 'wal-value' }))
    expect(beforeCopyMock.mock.calls.filter(([source]) => source === sourcePath)).toHaveLength(2)
    snapshot.cleanup()
  })

  it('retries when sidecars disappear after Chromium checkpoints on close', () => {
    const sourcePath = join(root, 'Chrome', 'Default', 'Cookies')
    writer = createChromiumCookieTestDatabase(
      sourcePath,
      [{ name: 'checkpointed', value: 'main-value' }],
      { journalMode: 'wal' }
    )
    beforeCopyMock.mockImplementationOnce((source: string) => {
      if (source === sourcePath) {
        writer?.close()
        writer = null
      }
    })

    const snapshot = createChromiumCookieSnapshot(sourcePath, { tempRoot: root })
    const database = new DatabaseSync(snapshot.databasePath, { readOnly: true })
    const row = database.prepare("SELECT value FROM cookies WHERE name = 'checkpointed'").get()
    database.close()

    expect(row).toEqual(expect.objectContaining({ value: 'main-value' }))
    expect(beforeCopyMock.mock.calls.filter(([source]) => source === sourcePath)).toHaveLength(2)
    snapshot.cleanup()
  })

  it('removes a partial snapshot when a WAL copy fails', () => {
    const sourcePath = join(root, 'Chrome', 'Default', 'Cookies')
    const snapshotsRoot = join(root, 'snapshots')
    mkdirSync(snapshotsRoot)
    writer = createChromiumCookieTestDatabase(sourcePath, [{ name: 'session', value: 'value' }], {
      journalMode: 'wal'
    })
    beforeCopyMock.mockImplementation((source: string) => {
      if (source === `${sourcePath}-wal`) {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      }
    })

    expect(() => createChromiumCookieSnapshot(sourcePath, { tempRoot: snapshotsRoot })).toThrow(
      'permission denied'
    )
    expect(readdirSync(snapshotsRoot)).toEqual([])
  })

  it('removes its temporary directory when the source database is missing', () => {
    const snapshotsRoot = join(root, 'snapshots')
    mkdirSync(snapshotsRoot)

    expect(() =>
      createChromiumCookieSnapshot(join(root, 'missing', 'Cookies'), {
        tempRoot: snapshotsRoot
      })
    ).toThrow('does not exist')
    expect(readdirSync(snapshotsRoot)).toEqual([])
  })
})
