import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countBlockingApis, main } from './check-main-blocking-api-ratchet.mjs'

const file = 'src/main/consumer.ts'
const counts = (source, name = file) =>
  Object.fromEntries(
    [...countBlockingApis(new Map([[name, source]]))].map(([category, rows]) => [
      category,
      rows.get(name) ?? 0
    ])
  )
const roots = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('main blocking API ratchets', () => {
  it('counts import aliases, namespace APIs, CommonJS and Atomics aliases by category', () => {
    expect(
      counts(`import { scryptSync as hash } from 'node:crypto'
      import * as z from 'node:zlib'
      const { pbkdf2Sync } = require('crypto')
      hash('pw'); pbkdf2Sync('pw'); z.gzipSync('bytes'); z.futureSync('bytes')
      const { wait: sleep } = Atomics; sleep(buffer, 0, 0)`)
    ).toEqual({ compression: 2, crypto: 2, atomics: 1, sqlite: 0, ipc: 0 })
  })

  it.each([
    ["import { DatabaseSync as DB } from 'node:sqlite'", 'DB'],
    ["import DB from 'better-sqlite3'", 'DB'],
    ["import DB from '../sqlite/sync-database'", 'DB'],
    ["const { DatabaseSync: DB } = require('node:sqlite')", 'DB'],
    ["import * as sqlite from 'node:sqlite'", 'sqlite.DatabaseSync']
  ])('guards SQLite constructors and statement work: %s', (load, ctor) => {
    expect(
      counts(`${load}
      const db = new ${ctor}('db')
      db.exec('schema')
      const statement = db.prepare('select')
      statement.run(); statement.get(); statement.all()
      db.prepare('select').get()`)
    ).toEqual({ compression: 0, crypto: 0, atomics: 0, sqlite: 8, ipc: 0 })
  })

  it('guards typed SQL receivers without charging Map.get or async backup', () => {
    expect(
      counts(`import type Database from '../sqlite/sync-database'
      class Owner {
        db: Database.Database | null
        query() { this.db.prepare('select').get(); this.db.backup('copy') }
      }
      function query(db: Database.Database, statement: Database.Statement, cache: Map<string, Database.Database>) {
        db.exec('schema'); statement.run(); cache.get('key')
      }`)
    ).toEqual({ compression: 0, crypto: 0, atomics: 0, sqlite: 4, ipc: 0 })
  })

  it('guards synchronous preload requests and main replies', () => {
    expect(
      counts(
        "import { ipcRenderer as ipc } from 'electron'; ipc.sendSync('get')",
        'src/preload/index.ts'
      ).ipc
    ).toBe(1)
    expect(counts("ipcMain.on('get', (event) => { event.returnValue = value })").ipc).toBe(1)
  })

  it('exempts only an explicit entry, leaving shared worker dependencies guarded', () => {
    const source = "import { scryptSync } from 'crypto'; scryptSync('pw')"
    expect(counts(source, 'src/main/speech/stt-worker.ts').crypto).toBe(0)
    expect(counts(source, 'src/main/speech/dependency.ts').crypto).toBe(1)
    expect(counts(source, 'src/shared/speech.ts').crypto).toBe(1)
  })

  it('ignores strings, comments, unrelated SQL-shaped methods and nonblocking APIs', () => {
    expect(
      counts(`import * as c from 'node:crypto'; import * as z from 'node:zlib'
      c.scrypt('pw'); z.gzip('bytes'); Atomics.waitAsync(buffer, 0, 0)
      const db = { prepare() {}, exec() {}, get() {} }; db.prepare(); db.get(); db.exec()
      const example = "Atomics.wait(buffer, 0, 0)" // c.scryptSync('pw')
      `)
    ).toEqual({ compression: 0, crypto: 0, atomics: 0, sqlite: 0, ipc: 0 })
  })

  it('rejects growth and shrinkage; prune cannot raise a baseline', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-blocking-ratchet-'))
    roots.push(root)
    mkdirSync(path.join(root, 'src/main'), { recursive: true })
    mkdirSync(path.join(root, 'config'))
    const cryptoFile = path.join(root, 'config/main-blocking-crypto-baseline.txt')
    writeFileSync(path.join(root, file), "import { scryptSync } from 'crypto'; scryptSync('pw')")
    for (const category of ['crypto', 'compression', 'atomics', 'sqlite', 'ipc']) {
      writeFileSync(path.join(root, `config/main-blocking-${category}-baseline.txt`), '# debt\n')
    }
    execFileSync('git', ['init', '--quiet'], { cwd: root })
    execFileSync('git', ['add', '.'], { cwd: root })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(main(root)).toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('Move CPU or SQL work to a worker')
    main(root, '--prune')
    expect(readFileSync(cryptoFile, 'utf8')).not.toContain('1 src/')
    writeFileSync(cryptoFile, '1 src/main/consumer.ts\n')
    expect(main(root)).toBe(0)
    writeFileSync(path.join(root, file), '')
    expect(main(root)).toBe(1)
    main(root, '--prune')
    expect(main(root)).toBe(0)
  })
})
