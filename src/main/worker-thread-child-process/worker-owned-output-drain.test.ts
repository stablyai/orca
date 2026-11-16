import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import type {
  WorkerThreadChildEvent,
  WorkerThreadChildRequest
} from './worker-thread-child-process-protocol'

const { spawn, verify } = vi.hoisted(() => ({ spawn: vi.fn(), verify: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn }))
vi.mock('@orca/process-host/posix-group-termination', () => ({
  createPosixGroupTermination: (_child: unknown, onTerminated: () => void) => ({
    stop: () => {
      verify.mockImplementation(onTerminated)
      return Promise.resolve(true)
    },
    close: () => {}
  })
}))

import { WorkerThreadChildProcessHost } from './worker-thread-child-process'
import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

it.skipIf(process.platform === 'win32')(
  'drains paused output after group proof before retiring the worker transport',
  async () => {
    const acknowledgements: WorkerThreadChildRequest[] = []
    const server = Object.assign(new EventEmitter(), {
      postMessage: (event: WorkerThreadChildEvent) => transport.emit('message', event)
    })
    const transport = Object.assign(new EventEmitter(), {
      postMessage: (request: WorkerThreadChildRequest) => {
        if (request.type === 'output-consumed') {
          acknowledgements.push(request)
        } else {
          queueMicrotask(() => server.emit('message', request))
        }
      },
      unref: () => {},
      terminate: async () => 0
    })
    serveWorkerThreadChildProcesses(server)
    const host = new WorkerThreadChildProcessHost(() => transport)
    for (let cycle = 0; cycle < 3; cycle++) {
      const stdout = Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(65_536, 97)))
      const stderr = Readable.from(Array.from({ length: 8 }, () => Buffer.alloc(65_536, 98)))
      const stdin = new PassThrough()
      const nativeChild = Object.assign(new EventEmitter(), {
        stdout,
        stderr,
        stdin,
        kill: vi.fn()
      })
      spawn.mockReturnValue(nativeChild)
      const child = host.spawn({ program: 'fixture', args: [], terminationBarrier: true })
      const received: Buffer[] = []
      child.stdout.on('data', (chunk) => received.push(chunk))
      child.stderr.on('data', (chunk) => received.push(chunk))
      const closed = new Promise<void>((resolve) => child.once('close', resolve))
      try {
        await nextTurn()
        expect(stdout.isPaused()).toBe(true)
        expect(stderr.isPaused()).toBe(true)
        child.stopOwnedGroup()
        await nextTurn()
        verify()
        // Proof precedes pipe close; acknowledgements must still reach the paused streams.
        while (!stdout.readableEnded || !stderr.readableEnded) {
          for (const acknowledgement of acknowledgements.splice(0)) {
            server.emit('message', acknowledgement)
          }
          await nextTurn()
        }
        nativeChild.emit('close', null, 'SIGKILL')
        await closed
        expect(Buffer.concat(received).byteLength).toBe(1_048_576)
        expect(Buffer.concat(received).filter((byte) => byte === 97).byteLength).toBe(524_288)
        expect(Buffer.concat(received).filter((byte) => byte === 98).byteLength).toBe(524_288)
      } finally {
        stdout.destroy()
        stderr.destroy()
        stdin.destroy()
      }
    }
  }
)
