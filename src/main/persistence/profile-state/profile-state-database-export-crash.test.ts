import { spawnProcess } from '../../../shared/child-process/run-process'
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { build } from 'esbuild'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importProfileStateJson } from './profile-state-documents'
import {
  openProfileStateDatabase,
  openProfileStateDatabaseReadOnly,
  profileStateDatabaseFile
} from './profile-state-database'
import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const interruptedExportScript = `
  import { openProfileStateDatabaseReadOnly } from './profile-state-database'
  import { writeProfileStateDatabaseSnapshotAsync } from './profile-state-database-snapshot'
  const { db } = openProfileStateDatabaseReadOnly(process.argv[2], 'profile-a')
  writeProfileStateDatabaseSnapshotAsync(db, process.argv[3], {
    validateStagedSnapshot: async (path) => {
      process.stdout.write(path + '\\n')
      await new Promise(() => setInterval(() => {}, 1_000))
    }
  }).catch((error) => { console.error(error); process.exit(1) })
`

async function killBeforePublication(sourcePath: string, targetPath: string): Promise<string> {
  const childEntry = join(dirname(sourcePath), 'interrupted-export.cjs')
  await build({
    stdin: {
      contents: interruptedExportScript,
      resolveDir: resolve('src/main/persistence/profile-state'),
      loader: 'ts'
    },
    outfile: childEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  const child = spawnProcess({
    program: process.execPath,
    args: [childEntry, sourcePath, targetPath],
    timeoutMs: 10_000
  })
  for (const stream of [child.stdin, child.stdout, child.stderr]) {
    stream?.on('error', () => {})
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once('close', () => resolve())
    child.once('error', reject)
  })
  const temporaryPath = await new Promise<string>((resolve, reject) => {
    let output = ''
    child.stdout.on('data', (chunk: Buffer | string) => {
      output += String(chunk)
      if (output.includes('\n')) {
        resolve(output.trim())
      }
    })
    child.once('close', () => reject(new Error('Export exited before staging completed')))
    child.once('error', reject)
  })
  child.kill('SIGKILL')
  await exited
  return temporaryPath
}

describe('profile state database export crash recovery', () => {
  it('leaves the destination intact when the production backup dies before publication', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-profile-state-export-crash-'))
    temporaryDirectories.push(directory)
    const sourcePath = profileStateDatabaseFile(directory)
    const source = openProfileStateDatabase(sourcePath, 'profile-a')
    importProfileStateJson(source.db, JSON.stringify({ settings: { theme: 'dark' } }), {
      now: () => 100
    })
    source.db.close()

    const targetPath = join(directory, 'recovery', 'profile-state.db')
    mkdirSync(join(directory, 'recovery'), { recursive: true })
    writeFileSync(targetPath, 'known-good-destination')
    const interruptedPath = await killBeforePublication(sourcePath, targetPath)

    expect(readFileSync(targetPath, 'utf8')).toBe('known-good-destination')
    expect(existsSync(interruptedPath)).toBe(true)
    rmSync(interruptedPath, { force: true })

    const recoveredSource = openProfileStateDatabase(sourcePath, 'profile-a')
    try {
      await writeProfileStateDatabaseSnapshotAsync(recoveredSource.db, targetPath)
    } finally {
      recoveredSource.db.close()
    }
    const snapshot = openProfileStateDatabaseReadOnly(targetPath, 'profile-a')
    try {
      expect(
        snapshot.db.prepare('SELECT value FROM profile_state_meta WHERE key = ?').get('revision')
      ).toEqual({ value: '1' })
    } finally {
      snapshot.db.close()
    }
  })
})
