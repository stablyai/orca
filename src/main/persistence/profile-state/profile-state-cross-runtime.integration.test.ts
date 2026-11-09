// Verify pinned Bun/Node databases, including unclean-exit WALs, open and back up in both directions.
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess, runProcessSync } from '@orca/process-host'
import {
  buildProfileStateCutoverFixture,
  canonicalProfileStateJson
} from '../profile-state-cutover-fixture'
import {
  locateBunForTests,
  locatePinnedNodeForTests,
  skipForMissingInputs
} from '../../orcad/orcad-node-slot-fixture'

const bun = locateBunForTests()
const node = locatePinnedNodeForTests()
const directory = mkdtempSync(join(tmpdir(), 'orca-profile-cross-runtime-'))
const entry = join(directory, 'cross-runtime.cjs')
const PROFILE_ID = 'cross-runtime'

/**
 * Bun on macOS links the system SQLite, which cannot open a cleanly closed WAL database
 * read-only (SQLITE_CANTOPEN), whoever wrote it. Production never runs this code under Bun,
 * so such a reader still proves it replays the unclean WAL but skips the read-only backup.
 */
function bunOpensClosedWalReadOnly(program: string): boolean {
  const probe = join(directory, 'readonly-wal-probe.db')
  const result = runProcessSync({
    program,
    args: [
      '-e',
      `const { DatabaseSync } = require('node:sqlite')
       const path = process.argv.at(-1)
       const db = new DatabaseSync(path)
       db.exec('PRAGMA journal_mode = WAL')
       db.exec('CREATE TABLE t(x)')
       db.close()
       new DatabaseSync(path, { readOnly: true }).prepare('PRAGMA user_version').get()`,
      probe
    ],
    timeoutMs: 30_000
  })
  rmSync(probe, { force: true })
  return result.code === 0
}
const bunReadOnlyWal = bun ? bunOpensClosedWalReadOnly(bun) : false

beforeAll(async () => {
  await build({
    stdin: {
      contents: `
        import { openProfileStateDatabase, openProfileStateDatabaseReadOnly } from './src/main/persistence/profile-state/profile-state-database'
        import { exportProfileStateJson, importProfileStateJson, readProfileStateRevision } from './src/main/persistence/profile-state/profile-state-documents'
        import { writeProfileStateBackup } from './src/main/persistence/profile-state/profile-state-backup-job'
        const [op, dbPath, profileId, payloadPath, backupPath] = process.argv.slice(2)
        const runtime = process.versions.bun ? 'bun' : 'node'
        if (op === 'write-unclean') {
          const opened = openProfileStateDatabase(dbPath, profileId)
          // Keep every committed frame in the WAL so the reader must replay it.
          opened.db.pragma('wal_autocheckpoint = 0')
          importProfileStateJson(opened.db, require('fs').readFileSync(payloadPath, 'utf8'), { now: () => 100 })
          console.log(JSON.stringify({ runtime, revision: readProfileStateRevision(opened.db) }))
          // Why SIGKILL: Bun closes and checkpoints open databases even on process.exit().
          process.kill(process.pid, 'SIGKILL')
        }
        ;(async () => {
          const opened = openProfileStateDatabase(dbPath, profileId)
          const exported = exportProfileStateJson(opened.db)
          const revision = readProfileStateRevision(opened.db)
          opened.db.close()
          if (process.env.CROSS_RUNTIME_SKIP_READONLY_BACKUP === '1') {
            console.log(JSON.stringify({ runtime, revision, exported, backedUp: null }))
            return
          }
          await writeProfileStateBackup({ databasePath: dbPath, profileId, targetPath: backupPath })
          const backup = openProfileStateDatabaseReadOnly(backupPath, profileId)
          const backedUp = exportProfileStateJson(backup.db)
          backup.db.close()
          console.log(JSON.stringify({ runtime, revision, exported, backedUp }))
        })().catch(error => { console.error(error); process.exit(1) })
      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron'],
    outfile: entry,
    logLevel: 'silent'
  })
})

afterAll(() => {
  rmSync(directory, { recursive: true, force: true })
})

async function run(
  program: string,
  args: string[],
  exit: 'clean' | 'killed' = 'clean',
  extraEnv: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  const result = await runProcess({
    program,
    args: [entry, ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ...extraEnv },
    timeoutMs: 60_000
  })
  if (exit === 'killed' && process.platform !== 'win32') {
    expect(result.signal, result.stderr).toBe('SIGKILL')
  } else if (exit === 'clean') {
    expect(result.code, result.stderr).toBe(0)
  }
  const parsed: unknown = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '')
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Unexpected fixture output: ${result.stdout}`)
  }
  return Object.fromEntries(Object.entries(parsed))
}

const skip = skipForMissingInputs('cross-runtime', [
  ...(bun ? [] : ['the pinned Bun (BUN_EXECUTABLE or bun on PATH)']),
  ...(node ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)'])
])

describe.skipIf(skip)('profile database across the pinned Bun and the pinned Node', () => {
  it.each([
    ['Bun', 'Node'],
    ['Node', 'Bun']
  ] as const)(
    'opens and backs up under %s -> %s after an unclean exit',
    async (writer, reader) => {
      const runtimes = { Bun: bun!, Node: node! }
      const caseDir = mkdtempSync(join(directory, `${writer}-to-${reader}-`))
      const dbPath = join(caseDir, 'profile-state.db')
      const payloadPath = join(caseDir, 'payload.json')
      const fixture = buildProfileStateCutoverFixture()
      writeFileSync(payloadPath, JSON.stringify(fixture))

      const written = await run(
        runtimes[writer],
        ['write-unclean', dbPath, PROFILE_ID, payloadPath],
        'killed'
      )
      expect(written.runtime).toBe(writer.toLowerCase())
      expect(existsSync(`${dbPath}-wal`)).toBe(true)
      expect(readFileSync(`${dbPath}-wal`).byteLength).toBeGreaterThan(0)

      const backupPath = join(caseDir, 'backup.db')
      const skipBackup = reader === 'Bun' && !bunReadOnlyWal
      const read = await run(
        runtimes[reader],
        ['read-and-backup', dbPath, PROFILE_ID, '', backupPath],
        'clean',
        skipBackup ? { CROSS_RUNTIME_SKIP_READONLY_BACKUP: '1' } : {}
      )
      expect(read.runtime).toBe(reader.toLowerCase())
      expect(read.revision).toBe(written.revision)
      const expected = canonicalProfileStateJson(fixture)
      expect(canonicalProfileStateJson(JSON.parse(String(read.exported)))).toBe(expected)
      if (!skipBackup) {
        expect(canonicalProfileStateJson(JSON.parse(String(read.backedUp)))).toBe(expected)
      }
    },
    60_000
  )
})
