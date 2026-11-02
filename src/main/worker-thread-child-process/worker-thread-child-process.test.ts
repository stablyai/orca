import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  IDLE_TEARDOWN_MS,
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

// Both halves joined by a real MessageChannel, so every event crosses structured
// clone exactly as it does between the main thread and the worker.
const openPorts: MessagePort[] = []
const terminations: number[] = []

function makeConnectedHost(): WorkerThreadChildProcessHost {
  return new WorkerThreadChildProcessHost(() => {
    const { port1, port2 } = new MessageChannel()
    openPorts.push(port1, port2)
    serveWorkerThreadChildProcesses(port2)
    const transport = new EventEmitter()
    port1.on('message', (message) => transport.emit('message', message))
    return Object.assign(transport, {
      postMessage: (message: unknown) => port1.postMessage(message),
      unref: () => port1.unref(),
      terminate: async () => {
        terminations.push(Date.now())
        port1.close()
        return 0
      }
    })
  })
}

function waitForClose(child: WorkerThreadChildProcess): Promise<[number | null, string | null]> {
  return new Promise((resolve) => child.once('close', (code, signal) => resolve([code, signal])))
}

function waitForSpawn(child: WorkerThreadChildProcess): Promise<number> {
  return new Promise((resolve, reject) =>
    child.once('spawn', () =>
      child.pid === undefined ? reject(new Error('spawn reported no pid')) : resolve(child.pid)
    )
  )
}

// Why the zombie check: libuv reaps a child only through its own loop's handle, so
// once the worker's loop is gone an exited POSIX child stays a zombie until Orca exits.
async function isRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'win32') {
    return true
  }
  const { stdout } = await runProcess({ program: 'ps', args: ['-o', 'stat=', '-p', String(pid)] })
  const state = stdout.trim()
  return state !== '' && !state.startsWith('Z')
}

async function waitUntilExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (!(await isRunning(pid))) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} is still running`)
}

const ECHO_SCRIPT = `
process.stdin.setEncoding('utf8')
process.stdin.on('data', (line) => process.stdout.write('echo:' + line))
process.stdin.on('end', () => { process.stderr.write('bye'); process.exit(7) })
`
const IDLE_SCRIPT = 'setInterval(() => {}, 1000)'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  terminations.length = 0
  for (const port of openPorts.splice(0)) {
    port.close()
  }
})

describe('WorkerThreadChildProcessHost over a message channel', () => {
  it('runs a real piped child across the message boundary', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', ECHO_SCRIPT]
    })
    const stdout: string[] = []
    const stderr: string[] = []
    // Data must arrive as a Buffer: the RPC reader calls chunk.toString().
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()))
    const closed = waitForClose(child)
    await waitForSpawn(child)

    child.stdin.write('{"id":1}\n')
    await new Promise((resolve) => child.stdout.once('data', resolve))
    child.stdin.end()

    await expect(closed).resolves.toEqual([7, null])
    expect(stdout.join('')).toBe('echo:{"id":1}\n')
    expect(stderr.join('')).toBe('bye')
    expect(child.exitCode).toBe(7)
    expect(child.kill()).toBe(false)
  }, 20_000)

  it('passes env and cwd through to the child', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', 'process.stdout.write(process.env.ORCA_PROBE_MARKER + "|" + process.cwd())'],
      cwd: process.cwd(),
      env: { ...process.env, ORCA_PROBE_MARKER: 'marker' }
    })
    const stdout: string[] = []
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()))

    await expect(waitForClose(child)).resolves.toEqual([0, null])
    expect(stdout.join('')).toBe(`marker|${process.cwd()}`)
  }, 20_000)

  it('reports a missing program as ENOENT so callers can say the CLI is not installed', async () => {
    const child = makeConnectedHost().spawn({
      program: 'orca-definitely-missing-program',
      args: []
    })
    const error = new Promise<NodeJS.ErrnoException>((resolve) => child.once('error', resolve))

    await expect(error).resolves.toMatchObject({ code: 'ENOENT' })
  }, 20_000)

  it('drops an error nobody listens for instead of throwing on the main loop', async () => {
    const child = makeConnectedHost().spawn({
      program: 'orca-definitely-missing-program',
      args: []
    })

    await expect(waitForClose(child)).resolves.toEqual([expect.any(Number), null])
  }, 20_000)

  it('closes a child whose creation threw on the worker', async () => {
    const child = makeConnectedHost().spawn({ program: '', args: [] })
    const errors: NodeJS.ErrnoException[] = []
    child.on('error', (error) => errors.push(error))

    await expect(waitForClose(child)).resolves.toEqual([-1, null])
    expect(errors).toMatchObject([{ code: 'ERR_INVALID_ARG_VALUE' }])
    expect(child.exitCode).toBe(-1)
  }, 20_000)

  it('kills a running child on request', async () => {
    const child = makeConnectedHost().spawn({
      program: process.execPath,
      args: ['-e', IDLE_SCRIPT]
    })
    await waitForSpawn(child)
    const closed = waitForClose(child)

    expect(child.kill()).toBe(true)

    const [code, signal] = await closed
    expect(code !== 0 || signal !== null).toBe(true)
  }, 20_000)

  it('fails closed, after listeners can attach, when no worker can be started', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = new WorkerThreadChildProcessHost(() => {
      throw new Error('entry missing')
    })

    const child = host.spawn({ program: process.execPath, args: [] })
    const events: unknown[][] = []
    child.on('error', (error: Error) => events.push(['error', error.message]))
    child.on('exit', (code) => events.push(['exit', code]))
    child.on('close', (code) => events.push(['close', code]))
    expect(events).toEqual([])
    await new Promise((resolve) => process.nextTick(resolve))

    expect(events).toEqual([
      ['error', 'Child process worker is unavailable'],
      ['exit', -1],
      ['close', -1]
    ])
    expect(child.kill()).toBe(false)
  })

  it('tears the idle worker down only after the last child closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = makeConnectedHost()
    const first = host.spawn({ program: process.execPath, args: ['-e', ''] })
    const second = host.spawn({ program: process.execPath, args: ['-e', IDLE_SCRIPT] })
    await waitForSpawn(second)
    await waitForClose(first)
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
    expect(terminations).toHaveLength(0)

    const secondClosed = waitForClose(second)
    second.kill()
    await secondClosed
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS - 1)
    expect(terminations).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(terminations).toHaveLength(1)
  }, 20_000)

  it('cancels a pending idle teardown when a new child spawns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const host = makeConnectedHost()
    await waitForClose(host.spawn({ program: process.execPath, args: ['-e', ''] }))

    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS - 1)
    const next = host.spawn({ program: process.execPath, args: ['-e', IDLE_SCRIPT] })
    await vi.advanceTimersByTimeAsync(IDLE_TEARDOWN_MS)
    expect(terminations).toHaveLength(0)

    const closed = waitForClose(next)
    next.kill()
    await closed
  }, 20_000)
})

// Why a real worker: only a real thread's death closes the child's pipes, which is
// the graceful stop an abandoned probe relies on instead of a pid-addressed kill.
describe('WorkerThreadChildProcessHost on a real worker thread', () => {
  let directory = ''
  let entryPath = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-worker-child-'))
    entryPath = join(directory, 'worker-thread-child-process-entry.cjs')
    await build({
      entryPoints: [join(__dirname, 'worker-thread-child-process-entry.ts')],
      outfile: entryPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  }, 60_000)

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it.each([
    ['terminated', (worker: Worker) => void worker.terminate()],
    // A null request throws inside the worker's message handler.
    ['crashed', (worker: Worker) => worker.postMessage(null)]
  ])(
    'lets the child exit on stdin EOF when its worker is %s',
    async (_, endWorker) => {
      let worker: Worker | undefined
      const host = new WorkerThreadChildProcessHost(() => (worker = new Worker(entryPath)))
      const marker = join(directory, `eof-${Date.now()}-${Math.random()}`)
      const child = host.spawn({
        program: process.execPath,
        args: [
          '-e',
          `process.stdin.resume();process.stdin.on('end',()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'');process.exit(0)});${IDLE_SCRIPT}`
        ]
      })
      const pid = await waitForSpawn(child)
      const abandoned = new Promise<Error>((resolve) => child.once('error', resolve))
      let closed = false
      child.on('close', () => (closed = true))
      if (!worker) {
        throw new Error('worker was not started')
      }

      endWorker(worker)

      await expect(abandoned).resolves.toMatchObject({
        message: expect.stringMatching(/^Child process worker (exited|failed)/)
      })
      await waitUntilExited(pid)
      expect(existsSync(marker)).toBe(true)
      expect(closed).toBe(false)
      expect(() => child.stdin.end()).not.toThrow()
      expect(child.kill()).toBe(false)
    },
    30_000
  )
})
