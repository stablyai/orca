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
