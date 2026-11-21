import { EventEmitter } from 'node:events'
import { PassThrough, Readable } from 'node:stream'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import type { WorkerThreadChildEvent } from './worker-thread-child-process-protocol'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawn }))

import { serveWorkerThreadChildProcesses } from './worker-thread-child-process-server'

// macOS launches spawn only after their async PATH lookup settles.
const untilSpawned = (): Promise<void> => vi.waitFor(() => expect(spawn).toHaveBeenCalled())

const CHUNKS = 256
const CHUNK_BYTES = 64 * 1024

function* outputBytes(chunks: number): Generator<Buffer> {
  for (let index = 0; index < chunks; index++) {
    const chunk = Buffer.alloc(CHUNK_BYTES, 0x61)
    chunk.writeUInt32LE(index)
    yield chunk
  }
}

it.each([1, CHUNKS])(
  'delivers %i chunks per pipe without pausing small replies',
  async (chunks) => {
    const stdout = Readable.from(outputBytes(chunks))
    const stderr = Readable.from(outputBytes(chunks))
    const pauseStdout = vi.spyOn(stdout, 'pause')
    const pauseStderr = vi.spyOn(stderr, 'pause')
    const stdin = new PassThrough()
    const child = Object.assign(new EventEmitter(), { stdout, stderr, stdin, kill: vi.fn() })
    spawn.mockReset().mockReturnValue(child)
    const events: WorkerThreadChildEvent[] = []
    const port = Object.assign(new EventEmitter(), {
      postMessage: (event: WorkerThreadChildEvent) => events.push(event)
    })
    serveWorkerThreadChildProcesses(port)
    try {
      port.emit('message', { type: 'spawn', id: 1, spec: { program: 'fixture', args: [] } })
      await untilSpawned()
      await nextTurn()
      if (chunks === 1) {
        expect(pauseStdout).not.toHaveBeenCalled()
        expect(pauseStderr).not.toHaveBeenCalled()
      } else {
        expect(pauseStdout).toHaveBeenCalled()
        expect(pauseStderr).toHaveBeenCalled()
      }
      const queuedBytes = events.reduce(
        (bytes, event) => bytes + ('chunk' in event ? event.chunk.byteLength : 0),
        0
      )
      expect(queuedBytes).toBeLessThan(1024 * 1024)
      const received = { stdout: 0, stderr: 0 }
      for (let turn = 0; turn < chunks * 4; turn++) {
        for (const event of events.splice(0)) {
          if (event.type === 'stdout' || event.type === 'stderr') {
            expect(event.chunk.byteLength).toBe(CHUNK_BYTES)
            expect(Buffer.from(event.chunk).readUInt32LE()).toBe(received[event.type]++)
            port.emit('message', { type: 'output-consumed', id: 1, bytes: event.chunk.byteLength })
          }
        }
        if (received.stdout === chunks && received.stderr === chunks) {
          break
        }
        await nextTurn()
      }
      expect(received).toEqual({ stdout: chunks, stderr: chunks })
    } finally {
      stdout.destroy()
      stderr.destroy()
      stdin.destroy()
      child.emit('close', 0, null)
    }
  }
)

it.each(['cancel-spawn', 'kill'] as const)(
  'never starts a launch stopped by %s while queued, and replays early requests for the next',
  async (stop) => {
    const stdin = new PassThrough()
    const endStdin = vi.spyOn(stdin, 'end')
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin,
      kill: vi.fn()
    })
    spawn.mockReset().mockReturnValue(child)
    const events: WorkerThreadChildEvent[] = []
    const port = Object.assign(new EventEmitter(), {
      postMessage: (event: WorkerThreadChildEvent) => events.push(event)
    })
    serveWorkerThreadChildProcesses(port)
    port.emit('message', { type: 'spawn', id: 1, spec: { program: 'cancelled', args: [] } })
    port.emit('message', { type: 'spawn', id: 2, spec: { program: 'kept', args: [] } })
    port.emit('message', { type: stop, id: 1 })
    port.emit('message', { type: 'stdin-end', id: 2 })
    await untilSpawned()

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]?.[0]).toMatchObject({ program: 'kept' })
    expect(events).toContainEqual({ type: 'close', id: 1, code: null, signal: 'SIGTERM' })
    expect(endStdin).toHaveBeenCalled()
  }
)

it('keeps output on the worker once the reader discards it', async () => {
  const stdout = new PassThrough()
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(),
    exitCode: null,
    signalCode: null
  })
  spawn.mockReset().mockReturnValue(child)
  const events: WorkerThreadChildEvent[] = []
  const port = Object.assign(new EventEmitter(), {
    postMessage: (event: WorkerThreadChildEvent) => events.push(event)
  })
  serveWorkerThreadChildProcesses(port)
  port.emit('message', { type: 'spawn', id: 1, spec: { program: 'git', args: [] } })
  await untilSpawned()
  stdout.write('read')
  await nextTurn()
  port.emit('message', { type: 'discard-output', id: 1 })
  stdout.write('discarded')
  await nextTurn()

  const forwarded = events.flatMap((event) =>
    event.type === 'stdout' ? [Buffer.from(event.chunk).toString()] : []
  )
  expect(forwarded).toEqual(['read'])
  expect(child.kill).not.toHaveBeenCalled()
  expect(stdout.destroyed).toBe(false)
})
