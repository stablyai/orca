import { build } from 'esbuild'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { preflightProfileStateRuntime } from './profile-state-runtime-preflight'

let directory: string
let workerPath: string
let backupWorkerPath: string

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'orca-preflight-test-'))
  workerPath = join(directory, 'profile-state-writer-worker-entry.js')
  backupWorkerPath = join(directory, 'profile-state-backup-worker-entry.js')
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts')
    ],
    outdir: directory,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

describe('profile runtime preflight', () => {
  it('requires a worker commit and an independently readable backup', async () => {
    const result = await preflightProfileStateRuntime({ workerPath, backupWorkerPath })
    expect(result.revision).toBe(1)
    expect(result.sqliteVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('refuses readiness when a required worker artifact is absent', async () => {
    await expect(
      preflightProfileStateRuntime({
        workerPath: join(directory, 'missing.js'),
        backupWorkerPath
      })
    ).rejects.toThrow('Profile state writer')
  })

  it('does not trust a backup success reply without a valid database', async () => {
    const corruptBackup = join(directory, 'corrupt-backup.cjs')
    writeFileSync(
      corruptBackup,
      `const { parentPort, workerData } = require('node:worker_threads')
       require('node:fs').writeFileSync(workerData.targetPath, 'not a database')
       parentPort.postMessage({ ok: true })
       parentPort.close()`
    )
    await expect(
      preflightProfileStateRuntime({ workerPath, backupWorkerPath: corruptBackup })
    ).rejects.toThrow()
  })
})
