import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RELAY_SENTINEL } from '../../ssh/protocol/relay-handshake'
import { waitForWslRelaySentinel } from './wsl-hook-relay-sentinel'

type FakeChild = ChildProcessWithoutNullStreams & { kill: ReturnType<typeof vi.fn> }

function fakeChild(): FakeChild {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter & {
      pause: ReturnType<typeof vi.fn>
      resume: ReturnType<typeof vi.fn>
    }
    stderr: EventEmitter
    stdin: EventEmitter & {
      write: ReturnType<typeof vi.fn>
      destroyed: boolean
      writable: boolean
    }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = Object.assign(new EventEmitter(), {
    pause: vi.fn(),
    resume: vi.fn()
  })
  child.stderr = new EventEmitter()
  const stdin = new EventEmitter() as EventEmitter & {
    write: ReturnType<typeof vi.fn>
    destroyed: boolean
    writable: boolean
  }
  stdin.write = vi.fn((_data, onWritten?: (error?: Error | null) => void) => {
    onWritten?.(null)
    return true
  })
  stdin.destroyed = false
  stdin.writable = true
  child.stdin = stdin
  child.kill = vi.fn()
  return child as unknown as FakeChild
}

function emitStdout(child: ChildProcessWithoutNullStreams, data: string | Buffer): void {
  child.stdout.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForWslRelaySentinel', () => {
  it('delivers a pending trailing chunk before a later direct chunk, in wire order', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    emitStdout(child, Buffer.concat([Buffer.from(RELAY_SENTINEL), Buffer.from('FIRST')]))
    const transport = await promise
    const received: string[] = []
    transport.onData((d) => received.push(d.toString('utf8')))
    // The queued microtask must flush before the next stdout macrotask.
    await new Promise<void>((resolve) => {
      setImmediate(() => {
        emitStdout(child, 'SECOND')
        resolve()
      })
    })
    expect(received).toEqual(['FIRST', 'SECOND'])
  })

  it('defers the pending flush to a microtask so a caller can finish wiring', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    emitStdout(child, Buffer.concat([Buffer.from(RELAY_SENTINEL), Buffer.from('DEFER')]))
    const transport = await promise
    const received: string[] = []
    transport.onData((d) => received.push(d.toString('utf8')))
    // Allow remaining synchronous handler registration before dispatching the first frame.
    expect(received).toEqual([])
    await Promise.resolve()
    expect(received).toEqual(['DEFER'])
  })

  it('forwards write(false), callback settlement, and drain from WSL stdin', async () => {
    const child = fakeChild()
    const callback = vi.fn()
    const drain = vi.fn()
    const writeMock = child.stdin.write as ReturnType<typeof vi.fn>
    writeMock.mockImplementation((_data, onWritten) => {
      onWritten?.(null)
      return false
    })
    const promise = waitForWslRelaySentinel(child)
    emitStdout(child, RELAY_SENTINEL)
    const transport = await promise

    transport.onDrain?.(drain)
    expect(transport.write(Buffer.from('frame'), callback)).toBe(false)
    expect(callback).toHaveBeenCalledWith({ ok: true })
    child.stdin.emit('drain')
    expect(drain).toHaveBeenCalledOnce()
    expect(transport.supportsWriteSettlement).toBe(true)
  })
})
