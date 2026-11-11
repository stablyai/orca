import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
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
      resolve('src/main/persistence/profile-state/writer/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/backup/profile-state-backup-worker-entry.ts')
    ],
    entryNames: '[name]',
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
})
