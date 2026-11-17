import { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { runProcess, setBufferedProcessSpawner, spawnProcess } from '@orca/process-host'
import { _setWindowsTaskkillLauncherForTests } from '@orca/process-host/windows-tree-kill'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as WorkerChildModule from './worker-thread-child-process'

const worker = vi.hoisted(() => ({ available: true, spawn: vi.fn() }))
vi.mock('./worker-thread-child-process', async (original) => {
  const actual = await original<typeof WorkerChildModule>()
  return {
    ...actual,
    canSpawnOnWorkerThread: () => worker.available,
    spawnProcessOnWorkerThread: worker.spawn
  }
})

import { spawnBufferedProcessOnWorker } from './buffered-process-worker-spawner'
import {
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess,
  WorkerThreadChildProcessHost
} from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

const originalPlatform = process.platform
const ports: MessagePort[] = []

function connectWorker(): void {
  const host = new WorkerThreadChildProcessHost(() => {
    const { port1, port2 } = new MessageChannel()
    ports.push(port1, port2)
    serveWorkerThreadChildProcesses(port2)
    const transport = new EventEmitter()
    port1.on('message', (message) => transport.emit('message', message))
    return Object.assign(transport, {
      postMessage: (message: unknown) => port1.postMessage(message),
      unref: () => port1.unref(),
      terminate: async () => {
        port1.close()
        return 0
      }
    })
  })
  worker.spawn.mockImplementation((spec) => host.spawn(spec))
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  worker.available = true
  worker.spawn.mockReset()
  setBufferedProcessSpawner(spawnBufferedProcessOnWorker)
})

afterEach(() => {
  setBufferedProcessSpawner(null)
  _setWindowsTaskkillLauncherForTests(null)
  for (const port of ports.splice(0)) {
    port.close()
  }
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  vi.useRealTimers()
})

describe('buffered Windows processes on the shared worker', () => {
  it('starts the deadline when the worker creates the process, not while the launch is queued', async () => {
    vi.useFakeTimers()
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const pending = runProcess({ program: 'gh.exe', args: ['--version'], timeoutMs: 2_500 })
    await vi.advanceTimersByTimeAsync(4_000)
    child.receive({ type: 'spawn', id: 1, pid: 4242 })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode('gh version 2.80.0') })
    child.receive({ type: 'exit', id: 1, code: 0, signal: null })
    child.receive({ type: 'close', id: 1, code: 0, signal: null })
    await expect(pending).resolves.toMatchObject({
      code: 0,
      timedOut: false,
      stdout: 'gh version 2.80.0'
    })
  })

  it.each(['hello λ', new Uint8Array([104, 101, 108, 108, 111, 32, 206, 187])])(
    'delivers stdin before EOF and captures both streams and a nonzero exit',
    async (input) => {
      connectWorker()
      const stderr: string[] = []
      const terminated = vi.fn()
      const result = await runProcess({
        program: process.execPath,
        args: [
          '-e',
          'process.stdin.pipe(process.stdout); process.stdin.on("end", () => { process.stderr.write("diagnostic"); process.exitCode = 7 })'
        ],
        input,
        captureStdoutAsBytes: true,
        onStderr: (chunk) => stderr.push(chunk.toString()),
        onChildTerminated: terminated
      })
      expect(result).toMatchObject({
        code: 7,
        signal: null,
        stdout: '',
        stdoutBytes: Buffer.from([104, 101, 108, 108, 111, 32, 206, 187]),
        stderr: 'diagnostic',
        timedOut: false,
        outputTruncated: false
      })
      expect(stderr.join('')).toBe('diagnostic')
      expect(terminated).toHaveBeenCalledOnce()
      expect(worker.spawn).toHaveBeenCalledWith(expect.objectContaining({ env: process.env }))
    }
  )

  it('preserves spawn ENOENT classification through the message channel', async () => {
    connectWorker()
    await expect(
      runProcess({ program: 'orca-definitely-missing-buffered-program' })
    ).rejects.toMatchObject({
      code: 'ENOENT',
      syscall: 'spawn orca-definitely-missing-buffered-program',
      path: 'orca-definitely-missing-buffered-program'
    })
  })

  it.each([false, true])(
    'settles abandonment after a swallowed stdin error (barrier %s)',
    async (barrier) => {
      const child = new WorkerThreadChildProcess(1, () => true)
      worker.spawn.mockReturnValue(child)
      const controller = new AbortController()
      const terminated = vi.fn()
      const pending = runProcess({
        program: 'probe.exe',
        signal: controller.signal,
        terminationBarrier: barrier,
        onChildTerminated: terminated
      })
      const outcome = expect(pending).rejects.toMatchObject({
        code: 'ERR_ORCA_WORKER_CHILD_ABANDONED',
        message: 'worker died'
      })
      if (barrier) {
        controller.abort()
      } else {
        child.receive({ type: 'spawn', id: 1, pid: 4321 })
      }
      child.receive({
        type: 'error',
        id: 1,
        error: { message: 'write EPIPE', syscall: 'write', code: 'EPIPE' }
      })
      child.receive({
        type: 'error',
        id: 1,
        error: { message: 'worker died', code: WORKER_CHILD_ABANDONED_CODE }
      })
      await outcome
      expect(terminated).toHaveBeenCalledOnce()
    }
  )

  it.each(['unavailable', 'uninstalled'])(
    'keeps native buffered execution when the worker spawner is %s',
    async (reason) => {
      worker.available = reason === 'uninstalled'
      if (reason === 'uninstalled') {
        setBufferedProcessSpawner(null)
      }
      const result = await runProcess({
        program: process.execPath,
        args: ['-e', 'process.stdout.write("native"); process.exitCode = 3']
      })
      expect(result).toMatchObject({ stdout: 'native', stderr: '', code: 3 })
      expect(worker.spawn).not.toHaveBeenCalled()
    }
  )

  it('leaves interactive spawnProcess children native even with the hook installed', async () => {
    const child = spawnProcess({ program: process.execPath, args: ['-e', 'process.exitCode = 4'] })
    child.stdin.end()
    await expect(new Promise((resolve) => child.once('close', resolve))).resolves.toBe(4)
    expect(worker.spawn).not.toHaveBeenCalled()
  })

  it('runs specs with nonstandard stdio natively', async () => {
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("discarded"); process.exitCode = 5'],
      stdio: 'ignore'
    })
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 5 })
    expect(worker.spawn).not.toHaveBeenCalled()
  })

  it('keeps tail and byte capture while an output limit stops an object barrier', async () => {
    vi.useFakeTimers()
    const child = new WorkerThreadChildProcess(1, () => true)
    worker.spawn.mockReturnValue(child)
    const pids: Array<number | undefined> = []
    const stderr: string[] = []
    const observed: string[] = []
    const pending = runProcess(
      {
        program: 'probe.exe',
        maxOutputBytes: 4,
        killOnOutputLimit: true,
        captureStderrAsBytes: true,
        onStderr: (chunk) => stderr.push(chunk.toString()),
        terminationBarrier: {
          observeStderr: (chunk) => observed.push(chunk.toString()),
          signal: async (handle) => {
            pids.push(handle.pid)
            return false
          },
          force: async (handle) => {
            pids.push(handle.pid)
            return true
          }
        }
      },
      'tail'
    )
    child.receive({ type: 'spawn', id: 1, pid: 4321 })
    child.receive({ type: 'stdout', id: 1, chunk: new TextEncoder().encode('123456') })
    child.receive({ type: 'stderr', id: 1, chunk: new TextEncoder().encode('abcdef') })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(pending).resolves.toMatchObject({
      stdout: '3456',
      stderr: '',
      stderrBytes: Buffer.from([99, 100, 101, 102]),
      timedOut: false,
      outputTruncated: true
    })
    expect(pids).toEqual([4321, 4321])
    expect(stderr).toEqual(['abcdef'])
    expect(observed).toEqual(['abcdef'])
  })

  it('waits for a late PID before walking the tree and keeps the root alive for taskkill', async () => {
    vi.useFakeTimers()
    const child = new WorkerThreadChildProcess(1, () => true)
    const rootKill = vi.spyOn(child, 'kill')
    worker.spawn.mockReturnValue(child)
    const killer = new ChildProcess()
    const launchTaskkill = vi.fn(() => killer)
    _setWindowsTaskkillLauncherForTests(launchTaskkill)
    const terminated = vi.fn()
    const pending = runProcess({
      program: 'probe.exe',
      timeoutMs: 10,
      terminationBarrier: true,
      onChildTerminated: terminated
    })

    // The launch never completes within the run's budget plus the queue allowance, so the run stops before any PID.
    await vi.advanceTimersByTimeAsync(30_010 + 8_000)
    expect(rootKill).not.toHaveBeenCalled()
    expect(launchTaskkill).not.toHaveBeenCalled()
    expect(terminated).not.toHaveBeenCalled()

    child.receive({ type: 'spawn', id: 1, pid: 4321 })
    expect(launchTaskkill).toHaveBeenCalledWith(4321)
    expect(rootKill).not.toHaveBeenCalled()
    killer.emit('close', 0)
    await expect(pending).resolves.toMatchObject({ timedOut: true })
    expect(terminated).toHaveBeenCalledOnce()
    expect(rootKill).not.toHaveBeenCalled()
  })
})
