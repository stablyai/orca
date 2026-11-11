import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { DesktopScriptServeChannel } from './desktop-script-serve-channel'

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

  failQueuedWrites(): void {
    for (const callback of this.pendingWrites.splice(0)) {
      callback(new Error('ERR_STREAM_DESTROYED'))
    }
  }
}

function createChannel() {
  const child = new FakeChild()
  const handlers = { onLine: vi.fn(), onGone: vi.fn(), onOverflow: vi.fn() }
  const channel = new DesktopScriptServeChannel(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements the piped streams and events consumed by the channel.
    child as unknown as ChildProcessWithoutNullStreams,
    handlers
  )
  return { channel, child, handlers }
}

describe('DesktopScriptServeChannel', () => {
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

  it('stops delivering a chunk when its line handler closes the channel', () => {
    const { channel, child, handlers } = createChannel()
    handlers.onLine.mockImplementation(() => channel.stop())
    child.stdout.emit('data', 'first\nsecond\n')
    expect(handlers.onLine.mock.calls.map(([line]) => line)).toEqual(['first'])
  })

  describe('once stopped', () => {
    /** Exercise channel guards directly so host guards cannot mask a missing check. */
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
