import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import type { MultiplexerTransport } from './ssh-multiplexer-transport-writer'
import { encodeFrame, MessageType, encodeKeepAliveFrame } from './remote-frame-protocol'
import { HEADER_LENGTH } from '../../../shared/relay-frame-decoder'

function createMockTransport(): MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
  closeCallbacks: (() => void)[]
  written: Buffer[]
} {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const written: Buffer[] = []

  return {
    write: (data: Buffer) => {
      written.push(data)
    },
    onData: (cb) => dataCallbacks.push(cb),
    onClose: (cb) => closeCallbacks.push(cb),
    dataCallbacks,
    closeCallbacks,
    written
  }
}

function makeResponseFrame(requestId: number, result: unknown, seq: number): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      result
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

function makeNotificationFrame(
  method: string,
  params: Record<string, unknown>,
  seq: number
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      method,
      params
    })
  )
  return encodeFrame(MessageType.Regular, seq, 0, payload)
}

describe('SshChannelMultiplexer', () => {
  let transport: ReturnType<typeof createMockTransport>
  let mux: SshChannelMultiplexer

  beforeEach(() => {
    vi.useFakeTimers()
    transport = createMockTransport()
    mux = new SshChannelMultiplexer(transport)
  })

  afterEach(() => {
    mux.dispose()
    vi.useRealTimers()
  })

  describe('request/response', () => {
    it('runs beforeResolve before an adjacent notification in the same decoder turn', async () => {
      const order: string[] = []
      mux.onNotification(() => order.push('notification'))
      const promise = mux.request(
        'pty.attach',
        { id: 'pty-1' },
        {
          beforeResolve: () => order.push('beforeResolve')
        }
      )

      transport.dataCallbacks[0](
        Buffer.concat([
          makeResponseFrame(1, { incarnationId: 'incarnation-1' }, 1),
          makeNotificationFrame('pty.data', { id: 'pty-1', data: 'first' }, 2)
        ])
      )

      expect(order).toEqual(['beforeResolve', 'notification'])
      await expect(promise).resolves.toEqual({ incarnationId: 'incarnation-1' })
    })

    it('times out after 30s with no response', async () => {
      const promise = mux.request('pty.spawn')

      // Keep connection liveness healthy while testing the longer request timeout.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      vi.advanceTimersByTime(1_000)

      await expect(promise).rejects.toThrow('timed out')
      const cancelFrame = transport.written.findLast((frame) => frame[0] === MessageType.Regular)
      if (!cancelFrame) {
        throw new Error('Missing RPC cancellation frame')
      }
      const cancelPayload = JSON.parse(
        cancelFrame.subarray(HEADER_LENGTH, HEADER_LENGTH + cancelFrame.readUInt32BE(9)).toString()
      )
      expect(cancelPayload).toMatchObject({
        method: 'rpc.cancel',
        params: { id: 1 }
      })
    })

    it('uses per-request timeout overrides', async () => {
      const promise = mux.request('fs.workspaceSpaceScan', {}, { timeoutMs: 60_000 })

      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      await Promise.resolve()
      const requestWrites = transport.written.filter((frame) => frame[0] === MessageType.Regular)
      expect(requestWrites).toHaveLength(1)

      for (let i = 6; i < 12; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      await expect(promise).rejects.toThrow('timed out after 60000ms')
    })
  })

  describe('notifications', () => {
    it('contains generic notification handler failures', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const badHandler = vi.fn(() => {
        throw new Error('subscriber exploded')
      })
      const goodHandler = vi.fn()
      mux.onNotification(badHandler)
      mux.onNotification(goodHandler)

      expect(() =>
        transport.dataCallbacks[0](makeNotificationFrame('pty.data', { id: 'pty-1' }, 1))
      ).not.toThrow()

      expect(badHandler).toHaveBeenCalled()
      expect(goodHandler).toHaveBeenCalledWith('pty.data', { id: 'pty-1' })
      expect(mux.isDisposed()).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        '[ssh-mux] Notification handler failed for pty.data: subscriber exploded'
      )
    })

    it('contains method notification handler failures', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const badHandler = vi.fn(() => {
        throw new Error('stream consumer exploded')
      })
      const goodHandler = vi.fn()
      mux.onNotificationByMethod('fs.streamChunk', badHandler)
      mux.onNotificationByMethod('fs.streamChunk', goodHandler)

      expect(() =>
        transport.dataCallbacks[0](
          makeNotificationFrame('fs.streamChunk', { streamId: 1, seq: 0, data: 'aGk=' }, 1)
        )
      ).not.toThrow()

      expect(badHandler).toHaveBeenCalled()
      expect(goodHandler).toHaveBeenCalledWith({ streamId: 1, seq: 0, data: 'aGk=' })
      expect(mux.isDisposed()).toBe(false)
      expect(warnSpy).toHaveBeenCalledWith(
        '[ssh-mux] Method notification handler failed for fs.streamChunk: stream consumer exploded'
      )
    })
  })

  describe('keepalive', () => {
    it('turns transport write failures into connection loss instead of throwing from the timer', () => {
      const writeError = new Error('write EPIPE')
      transport.write = vi.fn(() => {
        throw writeError
      })

      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
      expect(mux.isDisposed()).toBe(true)
    })
  })

  describe('wake guard (timer pause across system sleep, #7773)', () => {
    it('keeps the link alive after wake when frames resume', () => {
      vi.advanceTimersByTime(5_000)
      vi.setSystemTime(Date.now() + 60 * 60 * 1000)
      vi.advanceTimersByTime(5_000)

      // The relay answers the post-wake probe; the link must stay up.
      let seq = 1
      for (let i = 0; i < 8; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(seq++, 0))
      }
      expect(mux.isDisposed()).toBe(false)
    })

    it('still detects a genuinely dead link within the next window after wake', () => {
      vi.advanceTimersByTime(5_000)
      vi.setSystemTime(Date.now() + 60 * 60 * 1000)
      vi.advanceTimersByTime(5_000)

      expect(mux.isDisposed()).toBe(false)
      // No frames arrive after the guard reset; the honest window expires.
      vi.advanceTimersByTime(25_000)
      expect(mux.isDisposed()).toBe(true)
    })
  })

  describe('dispose', () => {
    it('tags a request after a shutdown dispose with DISPOSED', async () => {
      mux.dispose()

      const error = (await mux.request('pty.spawn').catch((e: unknown) => e)) as Error & {
        code?: string
      }
      expect(error.code).toBe('DISPOSED')
    })

    it('reports a request after a lost connection as transient', async () => {
      transport.closeCallbacks[0]()

      const error = (await mux
        .request('fs.readDir', { path: '/home/me' })
        .catch((e: unknown) => e)) as Error & { code?: string }
      expect(error.message).toBe('SSH connection lost, reconnecting...')
      expect(error.code).toBe('CONNECTION_LOST')
    })

    it('fires a dispose handler registered after dispose with the recorded reason', () => {
      mux.dispose('connection_lost')

      const disposeHandler = vi.fn()
      mux.onDispose(disposeHandler)

      expect(disposeHandler).toHaveBeenCalledWith('connection_lost')
      expect(disposeHandler).toHaveBeenCalledTimes(1)
    })
  })

  describe('transport close', () => {
    it('disposes multiplexer when transport closes', async () => {
      const promise = mux.request('pty.spawn')

      transport.closeCallbacks[0]()

      await expect(promise).rejects.toThrow('SSH connection lost, reconnecting...')
      expect(mux.isDisposed()).toBe(true)
    })
  })
})
