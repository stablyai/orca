import { setFlagsFromString } from 'node:v8'
import { afterEach, describe, expect, it } from 'vitest'
import { MAIN_WORKER_HEAP_LIMIT_MB, spawnWorkerThread } from './worker-thread-spawn'
import { WorkerThreadRequestQueue } from './worker-thread-request-queue'

const ECHO_OR_EXHAUST = `
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (request) => {
  if (request.exhaust) {
    const held = []
    for (;;) held.push(new Array(1e5).fill({ n: Math.random() }))
  }
  parentPort.postMessage({ id: request.id, ok: true })
})
`

const originalType = process.type
// V8 flags are process-wide; put back any launch heap flag (e.g. CI's NODE_OPTIONS) for later files.
const launchHeapFlag = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? '').split(/\s+/)].find(
  (arg) => arg.startsWith('--max-old-space-size=')
)
afterEach(() => {
  Object.defineProperty(process, 'type', { value: originalType, configurable: true })
  setFlagsFromString(launchHeapFlag ?? '--max-old-space-size=0')
})

function asMainProcess(): void {
  Object.defineProperty(process, 'type', { value: 'browser', configurable: true })
}

describe('spawnWorkerThread heap limit', () => {
  it('caps workers in main except durable writers, and leaves other processes alone', async () => {
    asMainProcess()
    const capped = spawnWorkerThread(ECHO_OR_EXHAUST, {
      eval: true,
      execArgv: [],
      name: 'orca-port-scan'
    })
    const writer = spawnWorkerThread(ECHO_OR_EXHAUST, {
      eval: true,
      execArgv: [],
      name: 'orca-journal-sql-writer'
    })
    Object.defineProperty(process, 'type', { value: 'utility', configurable: true })
    const utility = spawnWorkerThread(ECHO_OR_EXHAUST, {
      eval: true,
      execArgv: [],
      name: 'orca-port-scan'
    })
    try {
      expect(capped.resourceLimits?.maxOldGenerationSizeMb).toBe(MAIN_WORKER_HEAP_LIMIT_MB)
      expect(writer.resourceLimits?.maxOldGenerationSizeMb).not.toBe(MAIN_WORKER_HEAP_LIMIT_MB)
      expect(utility.resourceLimits?.maxOldGenerationSizeMb).not.toBe(MAIN_WORKER_HEAP_LIMIT_MB)
    } finally {
      await Promise.all([capped.terminate(), writer.terminate(), utility.terminate()])
    }
  })

  it('a worker that runs out of heap fails only its own call; the next call gets a fresh worker', async () => {
    asMainProcess()
    // A process-wide --max-old-space-size (CI's NODE_OPTIONS) overrides a worker's own limit.
    setFlagsFromString('--max-old-space-size=0')
    let spawned = 0
    const queue = new WorkerThreadRequestQueue<
      { id: number; exhaust?: boolean },
      { id: number; ok: boolean }
    >({
      factory: () => {
        spawned++
        const worker = spawnWorkerThread(ECHO_OR_EXHAUST, {
          eval: true,
          execArgv: [],
          name: 'orca-port-scan'
        })
        // Uncapped, the exhaust request would grow to V8's multi-GB default instead of failing.
        if (worker.resourceLimits?.maxOldGenerationSizeMb !== MAIN_WORKER_HEAP_LIMIT_MB) {
          void worker.terminate()
          throw new Error('worker spawned without the main-process heap cap')
        }
        return worker
      },
      idleTeardownMs: 60_000,
      maxConsecutiveDeaths: 3,
      createUnavailableError: (message) => new Error(message),
      describeTimeout: (ms) => `timed out after ${ms} ms`,
      describeExit: (code) => `exited ${code}`,
      describeCrashLoop: (message) => `crash loop: ${message}`,
      onUnavailable: () => {}
    })
    try {
      await expect(queue.dispatch((id) => ({ id, exhaust: true }), 30_000)).rejects.toMatchObject({
        code: 'ERR_WORKER_OUT_OF_MEMORY'
      })
      await expect(queue.dispatch((id) => ({ id }), 30_000)).resolves.toMatchObject({ ok: true })
      expect(spawned).toBe(2)
    } finally {
      queue.dispose()
    }
    // Filling a 512 MB worker heap takes seconds on a loaded CI runner.
  }, 60_000)
})
