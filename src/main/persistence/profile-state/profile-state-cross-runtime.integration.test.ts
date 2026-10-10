/**
 * Design D4 Phase 1 gate: a profile database Bun 1.4.2 wrote, WAL included after an unclean
 * exit, opens and backs up under the pinned Node, and the reverse — the rollback direction.
 * Today's source reaches Bun's own SQLite through its node:sqlite; the Bun adapter is gone.
 */
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
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
  exit: 'clean' | 'killed' = 'clean'
): Promise<Record<string, unknown>> {
  const result = await runProcess({
    program,
    args: [entry, ...args],
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
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
  ...(bun ? [] : ['Bun 1.4.2 (BUN_EXECUTABLE or bun on PATH)']),
  ...(node ? [] : ['the pinned Node (ORCA_PINNED_NODE or out/runtimes)'])
])

describe.skipIf(skip)('profile database across Bun 1.4.2 and the pinned Node', () => {
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
      const read = await run(runtimes[reader], [
        'read-and-backup',
        dbPath,
        PROFILE_ID,
        '',
        backupPath
      ])
      expect(read.runtime).toBe(reader.toLowerCase())
      expect(read.revision).toBe(written.revision)
      const expected = canonicalProfileStateJson(fixture)
      expect(canonicalProfileStateJson(JSON.parse(String(read.exported)))).toBe(expected)
      expect(canonicalProfileStateJson(JSON.parse(String(read.backedUp)))).toBe(expected)
    },
    60_000
  )
})
