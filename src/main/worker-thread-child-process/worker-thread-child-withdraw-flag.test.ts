import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  createWorkerThreadChildProcessTestEntry,
  createWorkerThreadChildProcessTestHost
} from './worker-thread-child-process-worker.test-fixtures'

let entry: Awaited<ReturnType<typeof createWorkerThreadChildProcessTestEntry>>
let host: ReturnType<typeof createWorkerThreadChildProcessTestHost>

beforeAll(async () => {
  entry = await createWorkerThreadChildProcessTestEntry()
  host = createWorkerThreadChildProcessTestHost(entry.entryPath)
  host.releaseOutput()
})

afterAll(async () => {
  await host.dispose()
  await entry.dispose()
})

const closed = (child: ReturnType<typeof host.spawn>) =>
  new Promise<{ spawned: boolean; code: number | null }>((resolve) => {
    let spawned = false
    child.once('spawn', () => {
      spawned = true
    })
    child.once('close', (code: number | null) => resolve({ spawned, code }))
  })

// Runs real launches through the worker, and process creation can take seconds on Windows.
it('withdraws a queued launch whose flag was set, with no cancel ever sent', async () => {
  const marker = join(entry.directory, 'launched')
  const ahead = [1, 2, 3].map(() => host.spawn({ program: process.execPath, args: ['-e', ''] }))
  for (const child of ahead) {
    child.stdin.end()
  }
  const withdrawWhenSet = new Int32Array(new SharedArrayBuffer(4))
  const gated = host.spawn({
    program: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '')`],
    withdrawWhenSet
  })
  gated.stdin.end()
  const gatedClosed = closed(gated)
  // Set as main records the root's exit; the worker reads it only once it dequeues the launch.
  Atomics.store(withdrawWhenSet, 0, 1)

  await Promise.all(ahead.map(closed))
  expect(await gatedClosed).toEqual({ spawned: false, code: null })
  expect(gated.pid).toBeUndefined()
  expect(existsSync(marker)).toBe(false)
}, 30_000)
