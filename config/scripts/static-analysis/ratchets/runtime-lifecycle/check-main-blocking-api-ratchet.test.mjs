import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { main as fsMain } from './check-main-sync-fs-ratchet.mjs'
import '../../process-boundaries/check-main-sync-spawn-ratchet.mjs'
import { countBlockingApis, main } from './check-main-blocking-api-ratchet.mjs'
import { collectDirectBlockingSites } from './check-main-blocking-helper-ratchet.mjs'
import { collectBlockingHelperUses } from '../../process-boundaries/main-blocking-helper-propagation.mjs'
import { workerOnlyFiles } from '../../process-boundaries/main-blocking-import-graph.mjs'

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
  it('guards typed SQL receivers and pragmas without charging Map.get or async backup', () => {
    expect(
      counts(`import type Database from '../sqlite/sync-database'
      class Owner {
        db: Database.Database | null
        query() { this.db.prepare('select').get(); this.db.backup('copy'); this.db.pragma('synchronous = FULL') }
      }
      function query(db: Database.Database, statement: Database.Statement, cache: Map<string, Database.Database>) {
        db.exec('schema'); statement.run(); cache.get('key')
      }`)
    ).toEqual({ compression: 0, crypto: 0, atomics: 0, sqlite: 5, ipc: 0 })
  })

  it('guards constructor properties and namespace SQLite types', () => {
    expect(
      counts(`import type * as sqlite from 'node:sqlite'
      class Owner {
        constructor(private readonly db: sqlite.DatabaseSync, private readonly statement: sqlite.StatementSync) {}
        query() { this.db.prepare('select').get(); this.statement.run() }
      }
      function query(db: sqlite.DatabaseSync, statement: sqlite.StatementSync) { db.exec('sql'); statement.get() }
    `).sqlite
    ).toBe(5)
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

  it('rejects growth and shrinkage; prune cannot raise a baseline', async () => {
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
    mkdirSync(path.join(root, 'src/main/daemon'), { recursive: true })
    const daemon = path.join(root, 'src/main/daemon/daemon-entry.ts')
    writeFileSync(daemon, "import { statSync } from 'node:fs'; statSync('file')")
    writeFileSync(
      path.join(root, 'config/main-sync-fs-baseline.txt'),
      '1 src/main/daemon/daemon-entry.ts\n'
    )
    execFileSync('git', ['add', '.'], { cwd: root })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await fsMain(root)).toBe(0)
    writeFileSync(
      daemon,
      "import { statSync } from 'node:fs'; statSync('file'); statSync('another')"
    )
    expect(await fsMain(root)).toBe(1)
    expect(await main(root)).toBe(1)
    await main(root, '--prune')
    expect(readFileSync(cryptoFile, 'utf8')).not.toContain('1 src/')
    writeFileSync(cryptoFile, '1 src/main/consumer.ts\n')
    expect(await main(root)).toBe(0)
    writeFileSync(path.join(root, file), '')
    expect(await main(root)).toBe(1)
    await main(root, '--prune')
    expect(await main(root)).toBe(0)
  })

  it('counts callers of a sync helper in another file, not only the helper itself', () => {
    const sources = new Map([
      [
        'src/main/config-read.ts',
        `import { readFileSync } from 'node:fs'
        function readRaw(file: string) { return readFileSync(file, 'utf8') }
        export const readConfig = (file: string) => JSON.parse(readRaw(file))
        export function configPath() { return '/tmp/config.json' }`
      ],
      [
        'src/main/poller.ts',
        `import { readConfig, configPath } from './config-read'
        setInterval(() => readConfig(configPath()), 1000)`
      ]
    ])
    const { uses } = collectBlockingHelperUses(sources, collectDirectBlockingSites(sources), {
      depth: 1
    })
    expect(uses.get('src/main/poller.ts')?.count).toBe(1)
  })

  it('counts callers through locally exported imported helpers', () => {
    const sources = new Map([
      [
        'src/main/impl.ts',
        `import { readFileSync } from 'node:fs'
        export function readConfig() { return readFileSync('config') }
        export default function readDefault() { return readFileSync('default') }`
      ],
      [
        'src/main/barrel.ts',
        `import readDefault, { readConfig as read } from './impl'
        export { read as load, readDefault as default }`
      ],
      [
        'src/main/consumer.ts',
        `import readDefault, { load } from './barrel'
        load(); readDefault()`
      ]
    ])
    const { uses } = collectBlockingHelperUses(sources, collectDirectBlockingSites(sources), {
      depth: 1
    })
    expect(uses.get('src/main/consumer.ts')?.count).toBe(2)
  })

  it('exempts modules only worker entries import', () => {
    const entry = 'src/main/native-chat/agent-session-journal/journal-sql-worker-entry.ts'
    const graph = new Map([
      [entry, ['src/main/worker-only.ts', 'src/main/shared-store.ts']],
      ['src/main/index.ts', ['src/main/shared-store.ts']]
    ])
    const files = ['src/main/index.ts', 'src/main/worker-only.ts', 'src/main/shared-store.ts']
    expect([...workerOnlyFiles(graph, files)]).toEqual(['src/main/worker-only.ts'])
    // An event-loop entry a worker imports stays guarded, and so does everything it imports.
    graph.get(entry).push('src/main/index.ts')
    graph.get('src/main/index.ts').push('src/main/worker-only.ts')
    expect([...workerOnlyFiles(graph, files, ['src/main/index.ts'])]).toEqual([])
  })
})
