import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { initializeBunReadonlyWal } from './bun-readonly-wal'
import Database from './sync-database'

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof fs>()
  return { ...original, openSync: vi.fn(original.openSync) }
})

const directories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  const original = await vi.importActual<typeof fs>('node:fs')
  vi.mocked(fs.openSync).mockImplementation(original.openSync)
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(wal = true): string {
  const directory = fs.mkdtempSync(join(tmpdir(), 'orca-readonly-wal-'))
  directories.push(directory)
  const file = join(directory, 'state.db')
  const db = new Database(file)
  db.exec('CREATE TABLE state (id INTEGER PRIMARY KEY, value TEXT)')
  if (wal) {
    db.pragma('journal_mode=WAL')
  }
  db.close()
  return file
}

describe('readonly WAL initialization', () => {
  it('allows a clean WAL database to reopen without changing its bytes or admitting SQL writes', () => {
    const file = fixture()
    const bytes = fs.readFileSync(file)
    initializeBunReadonlyWal(file)
    if (process.platform !== 'win32') {
      expect(fs.statSync(`${file}-wal`).mode & 0o777).toBe(0o600)
    }
    const reader = new Database(file, { readonly: true })
    try {
      expect(reader.prepare('SELECT COUNT(*) AS count FROM state').get()).toEqual({ count: 0 })
      expect(() => reader.exec("INSERT INTO state VALUES(1,'write')")).toThrow()
    } finally {
      reader.close()
    }
    expect(fs.readFileSync(file)).toEqual(bytes)
  })

  it('leaves a concurrent writer’s newly published WAL intact', async () => {
    const file = fixture()
    const { openSync: open } = await vi.importActual<typeof fs>('node:fs')
    vi.mocked(fs.openSync).mockImplementation((path, flags, ...rest) => {
      if (path === `${file}-wal` && flags === 'wx') {
        fs.writeFileSync(path, 'concurrent writer evidence')
      }
      return open(path, flags, ...rest)
    })
    initializeBunReadonlyWal(file)
    expect(fs.readFileSync(`${file}-wal`, 'utf8')).toBe('concurrent writer evidence')
  })

  it('leaves a current writer’s WAL bytes intact', () => {
    const file = fixture()
    const writer = new Database(file)
    try {
      writer.exec("INSERT INTO state VALUES(1,'durable')")
      const before = fs.readFileSync(`${file}-wal`)
      initializeBunReadonlyWal(file)
      expect(fs.readFileSync(`${file}-wal`)).toEqual(before)
      const reader = new Database(file, { readonly: true })
      try {
        expect(reader.prepare('SELECT value FROM state').get()).toEqual({ value: 'durable' })
      } finally {
        reader.close()
      }
    } finally {
      writer.close()
    }
  })

  it.skipIf(process.platform === 'win32')('opens a cold WAL database through a symlink', () => {
    const file = fixture()
    const alias = join(directories[0]!, 'alias.db')
    fs.symlinkSync(file, alias)
    const reader = new Database(alias, { readonly: true })
    try {
      expect(reader.prepare('SELECT COUNT(*) AS count FROM state').get()).toEqual({ count: 0 })
      expect(fs.existsSync(`${alias}-wal`)).toBe(false)
    } finally {
      reader.close()
    }
  })

  it('does not add recovery evidence to a rollback-journal database or malformed file', () => {
    const file = fixture(false)
    initializeBunReadonlyWal(file)
    expect(fs.existsSync(`${file}-wal`)).toBe(false)
    fs.writeFileSync(file, 'not SQLite')
    initializeBunReadonlyWal(file)
    expect(fs.existsSync(`${file}-wal`)).toBe(false)
  })

  it.skipIf(process.platform !== 'darwin' || !process.versions.bun)(
    'preserves another connection’s exclusive lock while inspecting the database header',
    async () => {
      const file = fixture(false)
      const writer = new Database(file)
      const probe = () =>
        runProcess({
          program: process.execPath,
          args: [
            '-e',
            `const { Database } = require('bun:sqlite')
             const db = new Database(process.argv[1], { readonly: true })
             try { db.prepare('SELECT * FROM state').all(); process.stdout.write('readable') }
             catch (error) { process.stdout.write(error.code) }
             finally { db.close(true) }`,
            file
          ],
          timeoutMs: 5_000
        })
      try {
        writer.exec("BEGIN EXCLUSIVE; INSERT INTO state VALUES(1,'uncommitted')")
        expect(await probe()).toMatchObject({ code: 0, stdout: 'SQLITE_BUSY' })
        const reader = new Database(file, { readonly: true })
        reader.close()
        expect(await probe()).toMatchObject({ code: 0, stdout: 'SQLITE_BUSY' })
      } finally {
        writer.close()
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'does not follow an existing dangling WAL symlink',
    () => {
      const file = fixture()
      const outside = join(directories[0]!, 'unrelated')
      fs.symlinkSync(outside, `${file}-wal`)
      initializeBunReadonlyWal(file)
      expect(fs.existsSync(outside)).toBe(false)
      expect(fs.lstatSync(`${file}-wal`).isSymbolicLink()).toBe(true)
    }
  )
})
