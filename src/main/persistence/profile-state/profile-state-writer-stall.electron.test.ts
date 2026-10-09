import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { runProcess } from '../../../shared/child-process/run-process'
import { resolveElectronProbeLaunch } from '../../browser/electron-probe-display-launch'

const root = mkdtempSync(join(tmpdir(), 'orca-writer-electron-'))
const entry = join(root, 'main.cjs')
const slowWarningMs = Number(process.env.ORCA_PROFILE_STALL_WARNING_MS ?? 2_000)
const processTimeoutMs = slowWarningMs * 6 + 30_000

beforeAll(async () => {
  if (!Number.isFinite(slowWarningMs) || slowWarningMs <= 0) {
    throw new Error('Invalid stall warning threshold')
  }
  await Promise.all(
    [
      ['profile-state-writer-electron-fixture.ts', 'main.cjs'],
      ['profile-state-writer-worker-entry.ts', 'worker.cjs']
    ].map(([source, output]) =>
      build({
        entryPoints: [resolve(__dirname, source)],
        outfile: join(root, output),
        bundle: true,
        platform: 'node',
        format: 'cjs',
        external: ['electron'],
        logLevel: 'silent'
      })
    )
  )
  writeFileSync(
    join(root, 'observed-worker.cjs'),
    `const { parentPort, workerData } = require('node:worker_threads')
     const counts = new Int32Array(workerData.counters)
     Atomics.add(counts, 1, 1)
     const post = parentPort.postMessage.bind(parentPort)
     parentPort.postMessage = response => {
       post(response)
       if (response.id > 0 && response.ok) {
         Atomics.add(counts, 0, 1)
         Atomics.notify(counts, 0)
       }
     }
     require('./worker.cjs')`
  )
})

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))

it(
  'keeps one SQLite writer alive across four Electron main-process stalls',
  async () => {
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Electron executable is unavailable')
    }
    const launch = resolveElectronProbeLaunch({
      electronBinary,
      electronArgs: [entry, root, String(slowWarningMs)],
      platform: process.platform,
      display: process.env.DISPLAY
    })
    const env: NodeJS.ProcessEnv = { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    delete env.ELECTRON_RUN_AS_NODE
    const processResult = await runProcess({
      program: launch.executable,
      args: launch.args,
      env,
      timeoutMs: processTimeoutMs
    })
    expect(processResult.timedOut, processResult.stderr).toBe(false)
    expect(processResult.code, processResult.stderr).toBe(0)
    const result: unknown = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'))
    expect(result).toMatchObject({
      electron: expect.any(String),
      slowWarningMs,
      revisions: [2, 3, 4, 5],
      durableRevision: 6,
      durableState: { ui: { marker: 'after' } },
      workerStarts: 1,
      failures: []
    })
  },
  processTimeoutMs + 5_000
)
