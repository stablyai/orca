import { deepStrictEqual } from 'node:assert'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { runProcessSync } from './script-child-process.mjs'
import {
  ORCAD_PROFILE_PREFLIGHT_FLAG,
  parseOrcadProfilePreflight
} from '../../src/shared/orcad-profile-preflight.ts'
import { ORCAD_BUN_VERSION } from '../../src/shared/orcad-bun-runtime.ts'

async function initializeFixture(directory, databasePath, profileId) {
  const fixture = join(directory, 'initialize.cjs')
  await build({
    stdin: {
      contents: `import { openProfileStateDatabase } from './src/main/persistence/profile-state/profile-state-database';
        export function initialize(path, profileId) { openProfileStateDatabase(path, profileId).db.close() }`,
      resolveDir: resolve(import.meta.dirname, '../..'),
      sourcefile: 'profile-state-build-fixture.ts'
    },
    outfile: fixture,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  createRequire(import.meta.url)(fixture).initialize(databasePath, profileId)
}

function runWorker(entry, workerData, steps, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, { workerData, execArgv: [] })
    let received = 0
    let failure
    const stop = (error) => {
      failure ??= error
      void worker.terminate().catch((terminationError) => {
        failure ??= terminationError
      })
    }
    const timer = setTimeout(() => stop(new Error(`${entry} timed out`)), timeoutMs)
    worker.on('message', (response) => {
      if (failure) {
        return
      }
      const step = steps[received]
      if (!step) {
        stop(new Error(`${entry} sent an unexpected response`))
        return
      }
      try {
        if (response?.ok === false) {
          throw new Error(`${entry}: ${response.error?.message ?? response.error}`)
        }
        for (const [key, expected] of Object.entries(step.reply)) {
          deepStrictEqual(response?.[key], expected, `${entry}: unexpected ${key}`)
        }
        received++
        const next = steps[received]
        if (next) {
          worker.postMessage(next.request)
        }
      } catch (error) {
        stop(error)
      }
    })
    worker.on('error', (error) => {
      failure ??= error
    })
    worker.once('exit', (code) => {
      clearTimeout(timer)
      if (failure || code !== 0 || received !== steps.length) {
        reject(failure ?? new Error(`${entry} exited before completing its protocol (${code})`))
      } else {
        resolve()
      }
    })
  })
}

/** Exercise the shipped entries and copied state before publishing their content version. */
export async function smokeProfileStateWorkers(outDir, { timeoutMs = 30_000, runtimePath } = {}) {
  if (runtimePath) {
    const nonce = randomUUID()
    const result = runProcessSync({
      program: runtimePath,
      args: [join(outDir, 'orcad.js'), ORCAD_PROFILE_PREFLIGHT_FLAG, nonce],
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs,
      maxOutputBytes: 64 * 1024
    })
    if (result.code !== 0 || result.timedOut || result.outputTruncated) {
      throw new Error(`Packaged profile runtime preflight failed: ${result.stderr}`)
    }
    parseOrcadProfilePreflight(result.stdout, nonce, ORCAD_BUN_VERSION)
    return
  }
  const directory = mkdtempSync(join(tmpdir(), 'orca-profile-worker-smoke-'))
  const databasePath = join(directory, 'profile.db')
  const targetPath = join(directory, 'backup.db')
  const profileId = 'build-smoke'
  const payload = JSON.stringify({ theme: 'dark', witness: 'saved \ud800 \u{1f419}' })
  try {
    await initializeFixture(directory, databasePath, profileId)
    await runWorker(
      join(outDir, 'profile-state-writer-worker-entry.js'),
      { databasePath, profileId, revision: 0 },
      [
        { reply: { id: 0, ok: true, revision: 0 } },
        {
          request: {
            id: 1,
            command: 'write-complete',
            replacements: [{ domain: 'settings', payload }]
          },
          reply: { id: 1, ok: true, revision: 1 }
        },
        {
          request: { id: 2, command: 'close' },
          reply: { id: 2, ok: true, revision: 1 }
        }
      ],
      timeoutMs
    )
    await runWorker(
      join(outDir, 'profile-state-backup-worker-entry.js'),
      { databasePath, profileId, targetPath },
      [{ reply: { ok: true } }],
      timeoutMs
    )
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
    const database = new DatabaseSync(targetPath, { readOnly: true })
    try {
      deepStrictEqual(database.prepare('PRAGMA quick_check').get()['quick_check'], 'ok')
      deepStrictEqual(
        database
          .prepare("SELECT payload FROM profile_state_documents WHERE domain = 'settings'")
          .get()?.payload,
        payload
      )
      deepStrictEqual(
        database.prepare("SELECT value FROM profile_state_meta WHERE key = 'revision'").get()
          ?.value,
        '1'
      )
    } finally {
      database.close()
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
