import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DesktopScriptServeChannel, type RuntimeChildProcess } from './desktop-script-serve-channel'

class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly writes: string[] = []
  killed = false
  private readonly pendingWrites: ((error?: Error | null) => void)[] = []

  readonly stdin = {
    write: (chunk: string, callback?: (error?: Error | null) => void): boolean => {
      this.writes.push(chunk)
      if (callback) {
        this.pendingWrites.push(callback)
      }
      return true
    },
    end: (): void => {},
    on: (): void => {}
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  /** What a destroyed stdin does to writes still queued at teardown. */
  failQueuedWrites(): void {
    for (const callback of this.pendingWrites.splice(0)) {
      callback(new Error('ERR_STREAM_DESTROYED'))
    }
  }
}

function createChannel() {
  const child = new FakeChild()
  const handlers = { onLine: vi.fn(), onGone: vi.fn(), onOverflow: vi.fn() }
  const channel = new DesktopScriptServeChannel(child as unknown as RuntimeChildProcess, handlers)
  return { channel, child, handlers }
}

describe('DesktopScriptServeChannel', () => {
  it('splits responses into lines and tolerates a trailing carriage return', () => {
    const { child, handlers } = createChannel()

    child.stdout.emit('data', Buffer.from('{"a":1}\r\n{"b":2}\n', 'utf8'))

    expect(handlers.onLine.mock.calls.map(([line]) => line)).toEqual(['{"a":1}', '{"b":2}'])
  })

  it('reports the exit reason with the stderr tail', () => {
    const { child, handlers } = createChannel()

    child.stderr.emit('data', Buffer.from('it broke', 'utf8'))
    child.emit('close', 1, null)

    expect(handlers.onGone).toHaveBeenCalledWith('code 1: it broke')
  })

  it('reassembles chunked responses with split UTF-8 and CRLF boundaries', () => {
    const { child, handlers } = createChannel()
    const payload = Buffer.from('hello 😀\r\n\nnext\ntrailing', 'utf8')
    for (const byte of payload) {
      child.stdout.emit('data', Buffer.from([byte]))
    }
    expect(handlers.onLine.mock.calls.map(([line]) => line)).toEqual(['hello 😀', 'next'])
    child.stdout.emit('data', '\n')
    expect(handlers.onLine).toHaveBeenLastCalledWith('trailing')
  })

  it('enforces the buffer cap before a terminating newline arrives', () => {
    const { child, handlers } = createChannel()
    const chunk = 'a'.repeat(1024 * 1024)
    for (let index = 0; index < 20; index += 1) {
      child.stdout.emit('data', chunk)
    }
    expect(handlers.onOverflow).not.toHaveBeenCalled()
    child.stdout.emit('data', 'a')
    expect(handlers.onOverflow).toHaveBeenCalledOnce()
    expect(handlers.onLine).not.toHaveBeenCalled()
    child.stdout.emit('data', 'recovered\n')
    expect(handlers.onLine).toHaveBeenCalledWith('recovered')
  })

  it('stops delivering a chunk when its line handler closes the channel', () => {
    const { channel, child, handlers } = createChannel()
    handlers.onLine.mockImplementation(() => channel.stop())
    child.stdout.emit('data', 'first\nsecond\n')
    expect(handlers.onLine.mock.calls.map(([line]) => line)).toEqual(['first'])
  })

  it('keeps the retained tail free of newlines after every drain', () => {
    const { channel, child } = createChannel()
    const retained = channel as unknown as { buffer: string }
    for (const chunk of ['a\nb', 'c\r\n\n\nd\ne', '\n', 'f\n\ng', Buffer.from('h\r\ni😀')]) {
      child.stdout.emit('data', chunk)
      // The fast path in readStdout scans only the new chunk, which is sound only if this holds.
      expect(retained.buffer).not.toContain('\n')
    }
    expect(retained.buffer).toBe('i😀')
  })

  it('scans only the new chunk for the first newline of a pending line', () => {
    const { child, handlers } = createChannel()
    const pending = 'p'.repeat(1024 * 1024)
    child.stdout.emit('data', pending)
    const chunk = 'q\n'
    const indexOf = vi.spyOn(String.prototype, 'indexOf')
    let scanned: number[]
    try {
      child.stdout.emit('data', chunk)
      scanned = indexOf.mock.contexts.map((self) => String(self).length)
    } finally {
      indexOf.mockRestore()
    }
    expect(handlers.onLine).toHaveBeenCalledWith(`${pending}q`)
    // Locating the delimiter must not rescan the megabytes already known to hold none.
    expect(scanned.length).toBeGreaterThan(0)
    expect(Math.max(...scanned)).toBeLessThanOrEqual(chunk.length)
  })

  it('releases the drained response that a retained tail was sliced from', () => {
    const gc = (globalThis as { gc?: () => void }).gc
    if (!gc) {
      throw new Error('global.gc unavailable - config/vitest.config.ts must pass --expose-gc')
    }
    const collectHeap = (): number => {
      gc()
      gc()
      return process.memoryUsage().heapUsed
    }
    const tails: string[] = []
    const feed = (index: number): void => {
      const child = new FakeChild()
      const channel = new DesktopScriptServeChannel(child as unknown as RuntimeChildProcess, {
        onLine: () => {},
        onGone: () => {},
        onOverflow: () => {}
      })
      const line = String.fromCharCode(65 + (index % 26)).repeat(1024 * 1024)
      child.stdout.emit('data', `${line}\n{"partial":${index}`)
      tails.push((channel as unknown as { buffer: string }).buffer)
    }
    for (let index = 0; index < 8; index += 1) {
      feed(index)
    }
    tails.length = 0
    const before = collectHeap()
    for (let index = 0; index < 32; index += 1) {
      feed(index)
    }
    const used = collectHeap() - before
    expect(tails).toHaveLength(32)
    expect(tails[5]).toBe('{"partial":5')
    // 32 pending tails, each sliced from a 1 Mi-char line; an un-owned tail pins the whole line.
    expect(used).toBeLessThan(4 * 1024 * 1024)
  })

  describe('once stopped', () => {
    /**
     * The channel's half of the stale-callback guard, pinned here rather than
     * through the host: the host refuses a stale report too, so a host-level
     * test passes with either guard alone and neither ends up covered.
     */
    it('accepts no further writes', () => {
      const { channel, child } = createChannel()

      channel.stop()
      channel.write('{"tool":"click"}\n', vi.fn())

      expect(child.writes).toEqual([])
    })

    it('reports no error from a write that was already queued', () => {
      const { channel, child } = createChannel()
      const onError = vi.fn()

      channel.write('{"tool":"click"}\n', onError)
      channel.stop()
      child.failQueuedWrites()

      expect(onError).not.toHaveBeenCalled()
    })

    it('reports neither lines nor the exit it was asked to cause', () => {
      const { channel, child, handlers } = createChannel()

      channel.stop()
      child.stdout.emit('data', Buffer.from('{"a":1}\n', 'utf8'))
      child.emit('close', 0, null)

      expect(handlers.onLine).not.toHaveBeenCalled()
      expect(handlers.onGone).not.toHaveBeenCalled()
    })
  })
})
