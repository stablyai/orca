// @orca-isolated-worker -- Suite hooks own the temporary host bundle.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { once: vi.fn() }, utilityProcess: { fork } }))
vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))

const { UtilityWorkerHost } = await import('./utility-worker-host')

let root = ''
let hostEntry = ''
let echoEntry = ''
let quietEntry = ''

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-utility-worker-host-'))
  hostEntry = join(root, 'utility-worker-host-entry.js')
  await build({
    entryPoints: [resolve('src/main/utility-worker-host/utility-worker-host-entry.ts')],
    outfile: hostEntry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  echoEntry = join(root, 'echo.js')
  writeFileSync(
    echoEntry,
    `const { parentPort, workerData } = require('node:worker_threads')
parentPort.postMessage({ hello: workerData.tag })
parentPort.on('message', (message) =>
  parentPort.postMessage(message.bytes ? new Uint8Array(message.bytes).fill(7) : { echo: message })
)`
  )
})
beforeAll(() => {
  quietEntry = join(root, 'quiet.js')
  writeFileSync(quietEntry, 'setInterval(() => undefined, 1000)')
})
const threads: Worker[] = []
// A host thread still starting must not outlive the bundle it loads.
afterAll(async () => {
  await Promise.all(threads.map((thread) => thread.terminate()))
  rmSync(root, { recursive: true, force: true })
})

/** Stands in for Electron's utility process: the real host entry on a thread with a parentPort. */
function threadUtilityProcess(): EventEmitter & {
  postMessage(message: unknown): void
  kill(): void
} {
  const thread = new Worker(
    `const { parentPort, workerData } = require('node:worker_threads')
process.parentPort = {
  on: (_event, listener) => parentPort.on('message', (data) => listener({ data })),
  postMessage: (message) => parentPort.postMessage(message)
}
require(workerData)`,
    { eval: true, workerData: hostEntry }
  )
  threads.push(thread)
  const child = Object.assign(new EventEmitter(), {
    stderr: null,
    postMessage: (message: unknown) => thread.postMessage(message),
    kill: () => {
      void thread.terminate()
      return true
    }
  })
  thread.on('message', (message) => child.emit('message', message))
  thread.on('exit', (code) => child.emit('exit', code))
  return child
}

function silentUtilityProcess(): EventEmitter & { postMessage(): void; kill(): void } {
  const child = Object.assign(new EventEmitter(), {
    stderr: null,
    postMessage: () => undefined,
    kill: () => {
      queueMicrotask(() => child.emit('exit', 9))
      return true
    }
  })
  queueMicrotask(() => child.emit('exit', 1))
  return child
}

function newHost(): InstanceType<typeof UtilityWorkerHost> {
  return new UtilityWorkerHost(
    'test host',
    () => hostEntry,
    ({ filename, workerData }) => new Worker(filename, { workerData })
  )
}

function nextMessage(worker: {
  once(event: 'message', listener: (value: unknown) => void): unknown
}) {
  return new Promise<unknown>((resolve) => worker.once('message', resolve))
}

function nextExit(worker: { once(event: 'exit', listener: (code: number) => void): unknown }) {
  return new Promise<number>((resolve) => worker.once('exit', resolve))
}

describe('UtilityWorkerHost', () => {
  beforeEach(() => fork.mockReset())

  it('relays a hosted worker both ways, including a message past one IPC chunk', async () => {
    fork.mockImplementation(threadUtilityProcess)
    const worker = newHost().spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'a' }
    })
    expect(await nextMessage(worker)).toEqual({ hello: 'a' })
    worker.postMessage({ bytes: 40 * 2 ** 20 })
    const reply = await nextMessage(worker)
    if (!(reply instanceof Uint8Array)) {
      throw new Error('expected the bytes back')
    }
    expect(reply.byteLength).toBe(40 * 2 ** 20)
    expect([reply[0], reply[32 * 2 ** 20], reply[40 * 2 ** 20 - 1]]).toEqual([7, 7, 7])
    const exited = nextExit(worker)
    await worker.terminate()
    await exited
  })

  it('runs workers in-process, messages kept, when the host exits before it is ready', async () => {
    fork.mockImplementation(silentUtilityProcess)
    const worker = newHost().spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'b' }
    })
    worker.postMessage('queued')
    expect(await nextMessage(worker)).toEqual({ hello: 'b' })
    expect(await nextMessage(worker)).toEqual({ echo: 'queued' })
    await worker.terminate()
  })

  it('ends a worker terminated before its first message without giving up the host', async () => {
    fork.mockImplementation(threadUtilityProcess)
    const host = newHost()
    const quiet = host.spawn({ filename: quietEntry, name: 'orca-journal-sql-reader' })
    await expect(quiet.terminate()).resolves.toEqual(expect.any(Number))
    const echo = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'd' }
    })
    expect(await nextMessage(echo)).toEqual({ hello: 'd' })
    expect(fork).toHaveBeenCalledTimes(1)
    await echo.terminate()
  })

  it('retries the host after a failed start once its cooldown passes', async () => {
    fork.mockImplementation(silentUtilityProcess)
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
    const host = newHost()
    const first = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'e' }
    })
    expect(await nextMessage(first)).toEqual({ hello: 'e' })
    const during = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'f' }
    })
    expect(await nextMessage(during)).toEqual({ hello: 'f' })
    expect(fork).toHaveBeenCalledTimes(1)
    now.mockReturnValue(1_000_000 + 1_001)
    fork.mockImplementation(threadUtilityProcess)
    const after = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'g' }
    })
    expect(await nextMessage(after)).toEqual({ hello: 'g' })
    expect(fork).toHaveBeenCalledTimes(2)
    now.mockRestore()
    await Promise.all([first.terminate(), during.terminate(), after.terminate()])
  })

  it('fails its workers when a running host dies', async () => {
    const children: ReturnType<typeof threadUtilityProcess>[] = []
    fork.mockImplementation(() => {
      const child = threadUtilityProcess()
      children.push(child)
      return child
    })
    const worker = newHost().spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'c' }
    })
    await nextMessage(worker)
    const failed = new Promise<Error>((resolve) => worker.once('error', resolve))
    const exited = nextExit(worker)
    children[0]?.kill()
    expect((await failed).message).toMatch(/^test host exited/)
    await exited
  })
})
