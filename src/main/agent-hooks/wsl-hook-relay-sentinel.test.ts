// Sentinel wait for the WSL relay: consuming stdout until the READY sentinel,
// handing trailing/subsequent bytes to the mux in wire order via the microtask
// flush, and failing (kill + reject) on overflow, close, timeout, and NUL noise.
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RELAY_SENTINEL, RELAY_SENTINEL_TIMEOUT_MS } from '../ssh/relay-protocol'
import {
  MAX_STARTUP_BUFFER_BYTES,
  waitForWslRelaySentinel,
  type WslRelayStartupFailure
} from './wsl-hook-relay-sentinel'

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

function emitStderr(child: ChildProcessWithoutNullStreams, data: Buffer): void {
  child.stderr.emit('data', data)
}

function catchStartup(
  promise: Promise<unknown>
): Promise<Error & { startup?: WslRelayStartupFailure }> {
  return promise.then(
    () => {
      throw new Error('expected the sentinel wait to reject')
    },
    (err: Error & { startup?: WslRelayStartupFailure }) => err
  )
}

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForWslRelaySentinel', () => {
  it('resolves when the sentinel is split across two chunks', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    const sentinel = Buffer.from(RELAY_SENTINEL)
    const mid = Math.floor(sentinel.length / 2)
    emitStdout(child, sentinel.subarray(0, mid))
    emitStdout(child, sentinel.subarray(mid))
    const transport = await promise
    expect(typeof transport.write).toBe('function')
    expect(typeof transport.onData).toBe('function')
    transport.pauseReads?.()
    transport.resumeReads?.()
    expect(child.stdout.pause).toHaveBeenCalledOnce()
    expect(child.stdout.resume).toHaveBeenCalledOnce()
  })

  it('resolves past leading garbage and hands trailing bytes to onData', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    emitStdout(
      child,
      Buffer.concat([Buffer.from('junk noise '), Buffer.from(RELAY_SENTINEL), Buffer.from('TRAIL')])
    )
    const transport = await promise
    const received: string[] = []
    transport.onData((d) => received.push(d.toString('utf8')))
    await Promise.resolve()
    expect(received).toEqual(['TRAIL'])
  })

  it('delivers a pending trailing chunk before a later direct chunk, in wire order', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    emitStdout(child, Buffer.concat([Buffer.from(RELAY_SENTINEL), Buffer.from('FIRST')]))
    const transport = await promise
    const received: string[] = []
    transport.onData((d) => received.push(d.toString('utf8')))
    // A real stdout 'data' event is a macrotask; the queued pending flush is a
    // microtask and must land ahead of any subsequent direct chunk.
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
    // Nothing dispatched synchronously at registration — a second handler could
    // still be added this tick before the first envelope flushes.
    expect(received).toEqual([])
    await Promise.resolve()
    expect(received).toEqual(['DEFER'])
  })

  it('kills the child and rejects when startup output exceeds 64 KiB before the sentinel', async () => {
    const child = fakeChild()
    const settled = catchStartup(waitForWslRelaySentinel(child))
    emitStdout(child, Buffer.alloc(MAX_STARTUP_BUFFER_BYTES + 1, 0x41))
    const err = await settled
    expect(err.message).toMatch(/64 KiB/)
    expect(child.kill).toHaveBeenCalled()
  })

  it('rejects with an exit failure when the child closes before the sentinel', async () => {
    const child = fakeChild()
    const settled = catchStartup(waitForWslRelaySentinel(child))
    child.emit('close', 7)
    const err = await settled
    expect(err.startup).toEqual({ kind: 'exit', code: 7, stderr: '' })
  })

  it('kills the child and rejects with a timeout after the sentinel deadline', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const settled = catchStartup(waitForWslRelaySentinel(child))
    await vi.advanceTimersByTimeAsync(RELAY_SENTINEL_TIMEOUT_MS + 1)
    const err = await settled
    expect(child.kill).toHaveBeenCalled()
    expect(err.startup?.kind).toBe('timeout')
  })

  it('strips NUL bytes from the stderr failure detail', async () => {
    const child = fakeChild()
    const settled = catchStartup(waitForWslRelaySentinel(child))
    // wsl.exe without WSL_UTF8 emits UTF-16LE — "E_FAIL" as NUL-interleaved ASCII.
    const nulLaden = Buffer.from('E_FAIL'.split('').flatMap((c) => [c.charCodeAt(0), 0]))
    emitStderr(child, nulLaden)
    child.emit('close', 1)
    const err = await settled
    expect(err.startup?.stderr).toBe('E_FAIL')
    expect(err.message).toContain('E_FAIL')
    expect(err.message).not.toContain(String.fromCharCode(0))
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

  it('swallows async stdin EPIPE after the guest dies so it is not uncaught', async () => {
    const child = fakeChild()
    const promise = waitForWslRelaySentinel(child)
    emitStdout(child, RELAY_SENTINEL)
    await promise
    // Real pipes emit EPIPE on the stream after a failed write; without a
    // listener Node surfaces that as an unhandled exception (CI flake).
    expect(() => {
      child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    }).not.toThrow()
  })
})
