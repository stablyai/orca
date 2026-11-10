import { setImmediate as nextTurn } from 'node:timers/promises'
import { Worker } from 'node:worker_threads'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from '../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildProcessHost } from '../../worker-thread-child-process/worker-thread-child-process'
import { createWorkerThreadChildProcessTestEntry } from '../../worker-thread-child-process/worker-thread-child-process-worker.test-fixtures'
import { workerExecFile } from './worker-exec-file'
import { execFileCapture } from './exec-file-capture'

const state = vi.hoisted(() => {
  const state: { host: WorkerThreadChildProcessHost | null } = { host: null }
  return state
})
vi.mock('../../worker-thread-child-process/worker-thread-child-process', async (original) => ({
  ...(await original<typeof WorkerChildModule>()),
  spawnProcessOnWorkerThread: (spec: Parameters<WorkerThreadChildProcessHost['spawn']>[0]) => {
    if (!state.host) {
      throw new Error('Test worker not initialized')
    }
    return state.host.spawn(spec)
  }
}))

let entryPath = ''
let disposeEntry: (() => Promise<void>) | undefined
const workers: Worker[] = []

beforeAll(async () => {
  const entry = await createWorkerThreadChildProcessTestEntry()
  entryPath = entry.entryPath
  disposeEntry = entry.dispose
})
afterAll(async () => {
  await Promise.all(workers.map((worker) => worker.terminate()))
  await disposeEntry?.()
})

async function createHost(gate?: SharedArrayBuffer) {
  const { WorkerThreadChildProcessHost } =
    await import('../../worker-thread-child-process/worker-thread-child-process')
  state.host = new WorkerThreadChildProcessHost(() => {
    // Hold this worker synchronously before process creation; the UI loop must still turn.
    const worker = gate
      ? new Worker(
          `const {workerData}=require('node:worker_threads');Atomics.wait(new Int32Array(workerData),0,0);require(${JSON.stringify(entryPath)})`,
          { eval: true, workerData: gate }
        )
      : new Worker(entryPath)
    workers.push(worker)
    return worker
  })
}

function capture(script: string, maxBuffer = 1024 * 1024) {
  let child: ReturnType<typeof workerExecFile> | undefined
  const result = new Promise<{
    error: Error | null
    stdout: string | Buffer
    stderr: string | Buffer
  }>((resolve) => {
    child = workerExecFile(
      process.execPath,
      ['-e', script],
      { maxBuffer },
      (error, stdout, stderr) => resolve({ error, stdout, stderr })
    )
  })
  if (!child) {
    throw new Error('Worker child was not created')
  }
  return { child, result }
}

describe('worker-owned Git capture', () => {
  it('keeps the caller responsive while process creation is blocked on the worker', async () => {
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const pending = capture('process.stdout.write("ready")')
    let completed = false
    void pending.result.then(() => {
      completed = true
    })
    try {
      await nextTurn()
      expect(completed).toBe(false)
    } finally {
      Atomics.store(new Int32Array(gate), 0, 1)
      Atomics.notify(new Int32Array(gate), 0)
    }
    await expect(pending.result).resolves.toMatchObject({ error: null, stdout: 'ready' })
  })

  it('preserves UTF-8, stdin, stderr and nonzero exit status', async () => {
    await createHost()
    const pending = capture(
      'process.stdin.setEncoding("utf8");process.stdin.on("data",data=>process.stdout.write(data));process.stdin.on("end",()=>{process.stderr.write("missing remote ref");process.exitCode=128})'
    )
    pending.child.stdin.write('orca 🐋')
    pending.child.stdin.end()
    await expect(pending.result).resolves.toMatchObject({
      stdout: 'orca 🐋',
      stderr: 'missing remote ref',
      error: { code: 128 }
    })
  })

  it('rejects overflowing output and bounds retained bytes', async () => {
    await createHost()
    const pending = capture('process.stdout.write("x".repeat(4096))', 32)
    await expect(pending.result).resolves.toMatchObject({
      stdout: 'x'.repeat(32),
      error: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }
    })
  })

  it('reports a missing executable without a successful empty result', async () => {
    await createHost()
    const result = new Promise<Error | null>((resolve) =>
      workerExecFile('/orca/nonexistent-git', [], { maxBuffer: 32 }, (error) => resolve(error))
    )
    await expect(result).resolves.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(process.platform !== 'darwin')('macOS worker capture stdin', () => {
  it.each([undefined, '', 'commit message\nλ\n'.repeat(10_000)])(
    'delivers stdin completely before EOF (%#)',
    async (input) => {
      await createHost()
      const result = await execFileCapture(
        process.execPath,
        [
          '-e',
          'process.stdin.setEncoding("utf8"); let input = ""; process.stdin.on("data", chunk => { input += chunk }); process.stdin.on("end", () => { process.stdout.write(JSON.stringify({ input })) })'
        ],
        {
          encoding: 'utf8',
          timeout: 3_000,
          spawnOnWorkerThread: true,
          ...(input === undefined ? {} : { stdin: input })
        }
      )

      expect(result).toEqual({ stdout: JSON.stringify({ input: input ?? '' }), stderr: '' })
    }
  )
})

describe.skipIf(process.platform !== 'darwin')('macOS worker capture cancellation', () => {
  it('does not report a queued child terminated until the worker processes its kill', async () => {
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const controller = new AbortController()
    const terminated = vi.fn()
    const pending = execFileCapture(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      spawnOnWorkerThread: true,
      signal: controller.signal,
      onChildTerminated: terminated
    })
    const outcome = pending.catch((error: unknown) => error)
    controller.abort()
    await expect(outcome).resolves.toMatchObject({ name: 'AbortError' })
    expect(terminated).not.toHaveBeenCalled()
    Atomics.store(new Int32Array(gate), 0, 1)
    Atomics.notify(new Int32Array(gate), 0)
    await vi.waitFor(() => expect(terminated).toHaveBeenCalledOnce())
  })

  it('does not infer child termination from worker loss before a spawn acknowledgement', async () => {
    const gate = new SharedArrayBuffer(4)
    await createHost(gate)
    const terminated = vi.fn()
    const pending = execFileCapture(process.execPath, ['-e', ''], {
      spawnOnWorkerThread: true,
      onChildTerminated: terminated
    })
    const outcome = pending.catch((error: unknown) => error)
    await workers.at(-1)?.terminate()
    await expect(outcome).resolves.toBeInstanceOf(Error)
    expect(terminated).not.toHaveBeenCalled()
  })
})
