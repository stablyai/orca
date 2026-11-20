// @orca-isolated-worker -- Suite hooks own the temporary host bundle.
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { serialize } from 'node:v8'
import { type MessagePort, Worker } from 'node:worker_threads'
import { build } from 'esbuild'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const fork = vi.hoisted(() => vi.fn())
vi.mock('electron', async () => {
  const { MessageChannel } = await import('node:worker_threads')
  return {
    app: { once: vi.fn() },
    utilityProcess: { fork },
    MessageChannelMain: class {
      port1: unknown
      port2: unknown
      constructor() {
        const { port1, port2 } = new MessageChannel()
        this.port1 = portMain(port1)
        this.port2 = portMain(port2)
      }
    }
  }
})

/** MessagePortMain over a node port: listeners get `{ data }`. Inlined in the host shim. */
const portMainSource = `(port) => ({
  raw: port,
  postMessage: (message) => port.postMessage(message),
  on: (event, listener) =>
    event === 'message' ? port.on('message', (data) => listener({ data })) : port.on(event, listener),
  start: () => port.start(),
  close: () => port.close()
})`
function portMain(port: MessagePort) {
  return {
    raw: port,
    postMessage: (message: unknown) => port.postMessage(message),
    on: (event: string, listener: (...args: unknown[]) => void) =>
      event === 'message'
        ? port.on('message', (data) => listener({ data }))
        : port.on(event, listener),
    start: () => port.start(),
    close: () => port.close()
  }
}
const breadcrumb = vi.hoisted(() => vi.fn())
vi.mock('../crash-reporting/breadcrumbs/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: breadcrumb,
  recordCoalescedDurableCrashBreadcrumb: vi.fn()
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
let dyingEntry = ''
let oomEntry = ''
beforeAll(() => {
  // Loads, then fails its first request with the error Node gives a worker out of heap.
  oomEntry = join(root, 'oom.js')
  writeFileSync(
    oomEntry,
    `const { parentPort } = require('node:worker_threads')
parentPort.postMessage('loaded')
parentPort.on('message', () => {
  throw Object.assign(new Error('out of memory'), { code: 'ERR_WORKER_OUT_OF_MEMORY' })
})`
  )
  quietEntry = join(root, 'quiet.js')
  writeFileSync(quietEntry, 'setInterval(() => undefined, 1000)')
  // Loads, then dies on its first request before replying, as an out-of-memory parse would.
  dyingEntry = join(root, 'dying.js')
  writeFileSync(
    dyingEntry,
    `require('node:worker_threads').parentPort.on('message', () => process.exit(7))`
  )
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
const portMain = ${portMainSource}
process.parentPort = {
  on: (_event, listener) =>
    parentPort.on('message', ({ data, port }) => listener({ data, ports: port ? [portMain(port)] : [] })),
  postMessage: (message) => parentPort.postMessage(message)
}
require(workerData)`,
    { eval: true, workerData: hostEntry }
  )
  threads.push(thread)
  const child = Object.assign(new EventEmitter(), {
    stderr: null,
    postMessage: (data: unknown, ports: { raw: MessagePort }[] = []) => {
      const port = ports[0]?.raw
      thread.postMessage({ data, port }, port ? [port] : [])
    },
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

/** A ready host that does nothing on its own; the test speaks for it on the ports it receives. */
function scriptedUtilityProcess(): EventEmitter & { ports: { raw: MessagePort }[] } {
  const received: { raw: MessagePort }[] = []
  const child = Object.assign(new EventEmitter(), {
    stderr: null,
    ports: received,
    postMessage: (_data: unknown, ports: { raw: MessagePort }[] = []) => received.push(...ports),
    kill: () => true
  })
  queueMicrotask(() => child.emit('message', { type: 'ready' }))
  return child
}

const inProcess = vi.fn(
  ({ filename, workerData }: { filename: string; workerData?: unknown }) =>
    new Worker(filename, { workerData })
)

function newHost(
  crashCap?: ConstructorParameters<typeof UtilityWorkerHost>[4]
): InstanceType<typeof UtilityWorkerHost> {
  return new UtilityWorkerHost('test host', () => hostEntry, inProcess, undefined, crashCap)
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
  beforeEach(() => {
    fork.mockReset()
    inProcess.mockClear()
  })

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

  it('fails, never reruns in main, a worker that dies before its first reply', async () => {
    fork.mockImplementation(threadUtilityProcess)
    const host = newHost()
    const worker = host.spawn({ filename: dyingEntry, name: 'orca-claude-rewind-transcript' })
    const exited = nextExit(worker)
    worker.postMessage('parse')
    expect(await exited).toBe(7)
    expect(inProcess).not.toHaveBeenCalled()
    const next = host.spawn({
      filename: echoEntry,
      name: 'orca-workspace-space-scan',
      workerData: { tag: 'h' }
    })
    expect(await nextMessage(next)).toEqual({ hello: 'h' })
    expect(fork).toHaveBeenCalledTimes(1)
    await next.terminate()
  })

  it('pauses after repeated host crashes, never running work in main, until a retry', async () => {
    const children: ReturnType<typeof threadUtilityProcess>[] = []
    fork.mockImplementation(() => {
      const child = threadUtilityProcess()
      children.push(child)
      return child
    })
    const onPause = vi.fn()
    const onResume = vi.fn()
    const host = newHost({ crashes: 3, windowMs: 60_000, message: 'paused', onPause, onResume })
    const spawnEcho = () =>
      host.spawn({
        filename: echoEntry,
        name: 'orca-workspace-space-scan',
        workerData: { tag: 'x' }
      })
    for (let crash = 0; crash < 3; crash++) {
      const worker = spawnEcho()
      await nextMessage(worker)
      const failed = new Promise<Error>((resolve) => worker.once('error', resolve))
      const hostExited = new Promise((resolve) => children[crash]?.once('exit', resolve))
      const workerExited = nextExit(worker)
      children[crash]?.kill()
      const [error] = await Promise.all([failed, workerExited, hostExited])
      expect(error.message).toMatch(/^test host (exited|stopped)/)
    }
    expect(spawnEcho).toThrow('paused')
    expect(onPause).toHaveBeenCalledTimes(1)
    expect(fork).toHaveBeenCalledTimes(3)
    expect(inProcess).not.toHaveBeenCalled()
    host.retry()
    expect(onResume).toHaveBeenCalledTimes(1)
    const worker = spawnEcho()
    expect(await nextMessage(worker)).toEqual({ hello: 'x' })
    expect(fork).toHaveBeenCalledTimes(4)
    await worker.terminate()
  })

  it("records an out-of-memory worker's work while its host keeps running", async () => {
    fork.mockImplementation(threadUtilityProcess)
    const worker = new UtilityWorkerHost(
      'test host',
      () => hostEntry,
      inProcess,
      (workers) => ({ r0_readOp: `point:continuation-context x${workers.length}` })
    ).spawn({ filename: oomEntry, name: 'orca-journal-sql-reader', workerData: {} })
    await nextMessage(worker)
    const failed = new Promise<Error>((resolve) => worker.once('error', resolve))
    breadcrumb.mockClear()
    worker.postMessage('read')
    expect((await failed).message).toBe('out of memory')
    expect(breadcrumb).toHaveBeenCalledWith(
      'worker_thread_failed',
      expect.objectContaining({
        serviceName: 'test host',
        role: 'orca-journal-sql-reader',
        code: 'ERR_WORKER_OUT_OF_MEMORY',
        r0_readOp: 'point:continuation-context x1'
      })
    )
    await worker.terminate()
  })
  it("puts the host's last heap report into its exit breadcrumb", async () => {
    const children: ReturnType<typeof threadUtilityProcess>[] = []
    fork.mockImplementation(() => {
      const child = threadUtilityProcess()
      children.push(child)
      return child
    })
    const host = newHost()
    const first = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'i' }
    })
    await nextMessage(first)
    // The host reports its heaps as soon as its last worker leaves.
    await first.terminate()
    const second = host.spawn({
      filename: echoEntry,
      name: 'orca-journal-sql-reader',
      workerData: { tag: 'j' }
    })
    await nextMessage(second)
    second.on('error', () => undefined)
    const hostExited = new Promise((resolve) => children[0]?.once('exit', resolve))
    breadcrumb.mockClear()
    children[0]?.kill()
    await Promise.all([nextExit(second), hostExited])
    const exited = breadcrumb.mock.calls.find(([name]) => name === 'utility_worker_host_exited')
    expect(exited?.[1]).toMatchObject({
      hostHeapMB: expect.any(Number),
      heapReportWorkers: 0,
      w0_role: 'orca-journal-sql-reader'
    })
  })

  it('delivers a reply the host sent just before its process exited', async () => {
    let child: ReturnType<typeof scriptedUtilityProcess> | undefined
    fork.mockImplementation(() => (child = scriptedUtilityProcess()))
    const worker = newHost().spawn({ filename: echoEntry, name: 'orca-claude-rewind-transcript' })
    worker.on('error', () => undefined)
    await vi.waitFor(() => expect(child?.ports).toHaveLength(1))
    const replied = nextMessage(worker)
    const port = child!.ports[0]!.raw
    port.postMessage({ type: 'message', bytes: serialize({ result: 'copied' }), more: false })
    child!.emit('exit', 9)
    port.close()
    expect(await replied).toEqual({ result: 'copied' })
  })
})
