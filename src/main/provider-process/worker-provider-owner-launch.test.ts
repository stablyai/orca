import { EventEmitter } from 'node:events'
import { MessageChannel } from 'node:worker_threads'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeferredProviderOwner } from './deferred-provider-owner'
import type { ProviderSpawnSpec } from './provider-process-supervisor'
import { launchProviderOwnerOnWorker } from './worker-provider-owner-launch'
import type * as WorkerChildModule from '../worker-thread-child-process/worker-thread-child-process'
import { WorkerThreadChildProcessHost } from '../worker-thread-child-process/worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from '../worker-thread-child-process/worker-thread-child-process-server'
import type { WorkerRequestTransport } from '../worker-threads/worker-thread-transport'

const workerMock: {
  readyNow: boolean
  host: WorkerThreadChildProcessHost | null
} = vi.hoisted(() => ({
  readyNow: false,
  host: null
}))

vi.mock('../worker-thread-child-process/worker-thread-child-process', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerChildModule>()
  return {
    ...actual,
    spawnWorkerReadyNow: () => workerMock.readyNow,
    whenSpawnWorkerReady: async () => workerMock.readyNow,
    spawnProviderOwnerOnWorkerThread: (
      spec: Parameters<typeof actual.spawnProviderOwnerOnWorkerThread>[0]
    ) => {
      if (!workerMock.host) {
        return Promise.reject(new Error('Test worker host not initialized'))
      }
      return workerMock.host.spawnProviderOwner(spec)
    }
  }
})

function createInProcessWorkerHost(): {
  host: WorkerThreadChildProcessHost
  close: () => void
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
    close: () => {
      port1.close()
      port2.close()
    }
  }
}

describe.skipIf(process.platform === 'win32')('launchProviderOwnerOnWorker', () => {
  let closeHost: (() => void) | null = null

  afterEach(() => {
    workerMock.readyNow = false
    workerMock.host = null
    closeHost?.()
    closeHost = null
  })

  it('spawns the provider owner through the worker and attaches its 7 sockets without calling spawnHere', async () => {
    const setup = createInProcessWorkerHost()
    closeHost = setup.close
    workerMock.host = setup.host
    workerMock.readyNow = true
    expect(await setup.host.whenReady()).toBe(true)

    const spec: ProviderSpawnSpec = {
      program: process.execPath,
      args: ['-e', 'process.stdout.write("hello-from-worker"); process.stderr.write("err-msg")'],
      command: process.execPath,
      env: process.env,
      cwd: process.cwd(),
      detached: true,
      supervised: true,
      lifetime: 'one-shot',
      closeRequest: 'stdin-end-and-sigterm',
      stdinEndGraceMs: 1_000,
      sigtermGraceMs: 3_000
    }
    const owner = new DeferredProviderOwner()
    for (const stream of owner.stdio) {
      stream?.on('error', () => {})
    }
    const spawnHere = vi.fn(() => {
      throw new Error('spawnHere should not run when worker succeeds')
    })

    await launchProviderOwnerOnWorker(owner, spec, spawnHere, 5_000)

    expect(spawnHere).not.toHaveBeenCalled()
    expect(owner.pid).toBeGreaterThan(1)
    const stdout = await new Promise<string>((resolve) => {
      let data = ''
      owner.stdio[1]?.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
      })
      owner.stdio[1]?.on('end', () => resolve(data))
      owner.stdio[1]?.on('close', () => resolve(data))
    })
    expect(stdout).toBe('hello-from-worker')
  })

  it('falls back to spawnHere when the worker is not ready', async () => {
    workerMock.readyNow = false
    const spec: ProviderSpawnSpec = {
      program: process.execPath,
      args: ['-e', 'process.exit(0)'],
      command: process.execPath,
      env: process.env,
      cwd: process.cwd(),
      detached: true,
      supervised: true,
      lifetime: 'one-shot',
      closeRequest: 'stdin-end-and-sigterm',
      stdinEndGraceMs: 1_000,
      sigtermGraceMs: 3_000
    }
    const owner = new DeferredProviderOwner()
    for (const stream of owner.stdio) {
      stream?.on('error', () => {})
    }
    const spawnHere = vi.fn(() => {
      throw new Error('fallback-ran')
    })
    const errors: Error[] = []
    owner.on('error', (err: Error) => errors.push(err))

    await launchProviderOwnerOnWorker(owner, spec, spawnHere, 5_000)

    expect(spawnHere).toHaveBeenCalledTimes(1)
    expect(errors[0]?.message).toBe('fallback-ran')
  })
})
