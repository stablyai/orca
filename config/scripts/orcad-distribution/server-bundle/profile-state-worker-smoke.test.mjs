import { build } from 'esbuild'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeProfileStateWorkers } from './profile-state-worker-smoke.mjs'

const directories = []
const writerFilename = 'profile-state-writer-worker-entry.js'
const backupFilename = 'profile-state-backup-worker-entry.js'
let builtDirectory

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-worker-build-test-'))
  directories.push(directory)
  return directory
}

beforeAll(async () => {
  builtDirectory = fixtureDirectory()
  await Promise.all(
    ['writer', 'backup'].map((role) =>
      build({
        entryPoints: [
          resolve(`src/main/persistence/profile-state/profile-state-${role}-worker-entry.ts`)
        ],
        outfile: join(builtDirectory, `profile-state-${role}-worker-entry.js`),
        bundle: true,
        platform: 'node',
        target: 'node18',
        format: 'cjs',
        logLevel: 'silent'
      })
    )
  )
})

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('profile state build smoke', () => {
  it('writes through the built writer and verifies the built backup after handle release', async () => {
    await expect(smokeProfileStateWorkers(builtDirectory)).resolves.toBeUndefined()
  })

  it('does not accept a successful backup response without the copied database', async () => {
    const directory = fixtureDirectory()
    copyFileSync(join(builtDirectory, writerFilename), join(directory, writerFilename))
    writeFileSync(
      join(directory, backupFilename),
      `const { parentPort } = require('node:worker_threads')
      parentPort.postMessage({ ok: true })
      parentPort.close()`
    )
    await expect(smokeProfileStateWorkers(directory)).rejects.toMatchObject({
      code: 'ERR_SQLITE_ERROR',
      errcode: 14
    })
  })
})
