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

  it('rejects a worker that exits without completing its protocol', async () => {
    const directory = fixtureDirectory()
    writeFileSync(join(directory, writerFilename), 'process.exit(0)\n')
    await expect(smokeProfileStateWorkers(directory)).rejects.toThrow('before completing')
  })

  it('rejects a mismatched startup revision', async () => {
    const directory = fixtureDirectory()
    writeFileSync(
      join(directory, writerFilename),
      `const { parentPort } = require('node:worker_threads')
      parentPort.postMessage({ id: 0, ok: true, revision: 7 })
      parentPort.close()`
    )
    await expect(smokeProfileStateWorkers(directory)).rejects.toThrow('unexpected revision')
  })

  it('does not accept a close acknowledgement from a worker that remains alive', async () => {
    const directory = fixtureDirectory()
    writeFileSync(
      join(directory, writerFilename),
      `const { parentPort } = require('node:worker_threads')
      parentPort.postMessage({ id: 0, ok: true, revision: 0 })
      parentPort.on('message', ({ id }) => parentPort.postMessage({ id, ok: true, revision: 1 }))
      setInterval(() => {}, 1000)`
    )
    await expect(smokeProfileStateWorkers(directory, { timeoutMs: 2_000 })).rejects.toThrow(
      'timed out'
    )
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
    await expect(smokeProfileStateWorkers(directory)).rejects.toThrow()
  })
})
