import { EventEmitter } from 'node:events'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess, setDefaultProcessLauncher } from '@orca/process-host'
import type * as WorkerChildModule from '../../../worker-thread-child-process/worker-thread-child-process'
import { WorkerThreadChildProcessHost } from '../../../worker-thread-child-process/worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from '../../../worker-thread-child-process/worker-thread-child-process-server'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { launchPlainProcessSpecOnPosixWorker } from './process-spec-worker-launch'

const workerMock: {
  readyNow: boolean
  host: WorkerThreadChildProcessHost | null
} = vi.hoisted(() => ({
  readyNow: false,
  host: null
}))

vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => {
    const actual = await importOriginal<typeof WorkerChildModule>()
    return {
      ...actual,
      spawnWorkerReadyNow: () => workerMock.readyNow,
      spawnProcessOnWorkerThread: (
        spec: Parameters<typeof actual.spawnProcessOnWorkerThread>[0]
      ) => {
        if (!workerMock.host) {
          throw new Error('Test worker host not initialized')
        }
        return workerMock.host.spawn(spec)
      }
    }
  }
)

function createInProcessWorkerHost(): {
  host: WorkerThreadChildProcessHost
  close: () => void
  loseWorker: () => void
} {
  const { port1, port2 } = new MessageChannel()
  serveWorkerThreadChildProcesses(port2)
  const emitter = new EventEmitter()
  const transport: WorkerRequestTransport = {
    on: (event, listener) => emitter.on(event, listener),
    off: (event, listener) => emitter.off(event, listener),
    removeAllListeners: () => emitter.removeAllListeners(),
    postMessage: (message) => port1.postMessage(message),
    terminate: async () => {
      port1.close()
      port2.close()
      return 0
    },
    unref: () => {
      port1.unref()
      port2.unref()
    }
  }
  port1.on('message', (event) => emitter.emit('message', event))
  const host = new WorkerThreadChildProcessHost(() => transport)
  return {
    host,
    loseWorker: () => emitter.emit('exit', 1),
    close: () => {
      port1.close()
      port2.close()
    }
  }
}

describe.skipIf(process.platform === 'win32')('launchPlainProcessSpecOnPosixWorker', () => {
  let closeHost: (() => void) | null = null

  afterEach(() => {
    setDefaultProcessLauncher(null)
    workerMock.readyNow = false
    workerMock.host = null
    closeHost?.()
    closeHost = null
  })

  it('declines when the worker is not yet ready or when the spec needs main-thread guarantees', () => {
    workerMock.readyNow = false
    expect(launchPlainProcessSpecOnPosixWorker({ program: process.execPath })).toBeNull()

    workerMock.readyNow = true
    expect(
      launchPlainProcessSpecOnPosixWorker({
        program: process.execPath,
        terminationBarrier: 'wait-for-posix-group'
      })
    ).toBeNull()
    expect(
      launchPlainProcessSpecOnPosixWorker({
        program: process.execPath,
        terminationBarrier: {
          signal: async () => true,
          force: async () => true
        }
      })
    ).toBeNull()
    expect(
      launchPlainProcessSpecOnPosixWorker({
        program: process.execPath,
        onChildTerminated: () => {}
      })
    ).toBeNull()
    expect(
      launchPlainProcessSpecOnPosixWorker({
        program: process.execPath,
        detached: true
      })
    ).toBeNull()
  })

  it('runs terminationBarrier: true on the worker and kills its POSIX process group on abort', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    const abort = new AbortController()
    let stderrBuf = ''
    const result = await runProcess({
      program: process.execPath,
      args: [
        '-e',
        'const { spawn } = require("node:child_process"); const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.stderr.write(g.pid + "\\n"); setInterval(() => {}, 1000)'
      ],
      terminationBarrier: true,
      signal: abort.signal,
      onStderr: (chunk) => {
        stderrBuf += chunk.toString()
        if (stderrBuf.includes('\n')) {
          abort.abort()
        }
      },
      timeoutMs: 10_000
    })

    const grandchildPid = Number(stderrBuf.trim())
    expect(Number.isInteger(grandchildPid) && grandchildPid > 1).toBe(true)
    expect(result.timedOut).toBe(false)
    // The worker's POSIX process-group stop must have killed the grandchild too.
    expect(() => process.kill(grandchildPid, 0)).toThrow()
  })

  it('stops an overflowing terminationBarrier: true probe on the worker (readAgentCliVersion shape)', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(8192)); setInterval(() => {}, 1000)'],
      terminationBarrier: true,
      maxOutputBytes: 64,
      killOnOutputLimit: true,
      timeoutMs: 5_000
    })

    expect(result).toMatchObject({ outputTruncated: true, timedOut: false })
    expect(result.stdout.length).toBe(64)
  })

  it('preserves tail capture past maxOutputBytes on the worker', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    const result = await runProcess(
      {
        program: process.execPath,
        args: [
          '-e',
          'process.stdout.write("aaaa"); setTimeout(() => { process.stdout.write("bbbb"); setTimeout(() => process.stdout.write("cccc"), 15) }, 15)'
        ],
        maxOutputBytes: 4,
        timeoutMs: 5_000
      },
      'tail'
    )

    expect(result).toMatchObject({ code: 0, stdout: 'cccc', outputTruncated: true })
  })

  it('keeps forwarding stderr to onStderr past maxOutputBytes while capping captured stderr', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    const observed: string[] = []
    const result = await runProcess({
      program: process.execPath,
      args: [
        '-e',
        'process.stderr.write("1111"); setTimeout(() => { process.stderr.write("2222"); setTimeout(() => process.stderr.write("DONE"), 15) }, 15)'
      ],
      maxOutputBytes: 4,
      onStderr: (chunk) => observed.push(chunk.toString()),
      timeoutMs: 5_000
    })

    expect(result).toMatchObject({ code: 0, stderr: '1111', outputTruncated: true })
    expect(observed.join('')).toBe('11112222DONE')
  })

  it('kills a running child whose worker was lost, so it cannot outlive its timeout', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    let pid = 0
    const run = runProcess({
      program: process.execPath,
      // Never reads stdin, so closed pipes alone would not end it.
      args: ['-e', 'process.stderr.write(String(process.pid)); setInterval(() => {}, 1000)'],
      onStderr: (chunk) => {
        pid = Number(chunk.toString())
        setup.loseWorker()
      },
      timeoutMs: 30_000
    })

    await expect(run).rejects.toMatchObject({ code: 'ERR_ORCA_WORKER_CHILD_ABANDONED' })
    expect(pid).toBeGreaterThan(1)
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 5_000 })
  })

  it('leaves the group of an already-exited barrier root alone when its worker is lost', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    setDefaultProcessLauncher(launchPlainProcessSpecOnPosixWorker)
    let pids: number[] = []
    const run = runProcess({
      program: process.execPath,
      // The root exits at once; the helper it leaves behind keeps the output pipes open, so no close follows.
      args: [
        '-e',
        'const helper = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); process.stderr.write(process.pid + " " + helper.pid); process.exit(0)'
      ],
      terminationBarrier: true,
      onStderr: (chunk) => {
        pids = chunk.toString().split(' ').map(Number)
      },
      timeoutMs: 30_000
    })
    const settled = run.then(
      () => 'resolved',
      (error: NodeJS.ErrnoException) => error.code
    )
    await vi.waitFor(() => expect(pids).toHaveLength(2), { timeout: 5_000 })
    const [rootPid, helperPid] = pids
    try {
      // Reaped means the exit was posted; give that message a few turns to cross.
      await vi.waitFor(() => expect(() => process.kill(rootPid, 0)).toThrow(), { timeout: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 50))
      setup.loseWorker()

      expect(await settled).toBe('ERR_ORCA_WORKER_CHILD_ABANDONED')
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(() => process.kill(helperPid, 0)).not.toThrow()
    } finally {
      process.kill(helperPid, 'SIGKILL')
    }
  })

  it('gives spec.launch precedence over the default launcher even when it returns null', async () => {
    const defaultLauncher = vi.fn(() => null)
    const specLauncher = vi.fn(() => null)
    setDefaultProcessLauncher(defaultLauncher)

    const result = await runProcess({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      launch: specLauncher,
      timeoutMs: 5_000
    })

    expect(result).toMatchObject({ code: 0, stdout: 'ok' })
    expect(specLauncher).toHaveBeenCalledTimes(1)
    expect(defaultLauncher).not.toHaveBeenCalled()
  })
})
