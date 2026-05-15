import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { SshChannelMultiplexer, type MultiplexerTransport } from './ssh-channel-multiplexer'
import { encodeFrame, MessageType, HEADER_LENGTH, encodeKeepAliveFrame } from './relay-protocol'

function createMockTransport(): MultiplexerTransport & {
  dataCallbacks: ((data: Buffer) => void)[]
  closeCallbacks: (() => void)[]
  written: Buffer[]
} {
  const dataCallbacks: ((data: Buffer) => void)[] = []
  const closeCallbacks: (() => void)[] = []
  const written: Buffer[] = []

  return {
    write: (data: Buffer) => written.push(data),
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

function makeErrorResponseFrame(
  requestId: number,
  code: number,
  message: string,
  seq: number
): Buffer {
  const payload = Buffer.from(
    JSON.stringify({
      jsonrpc: '2.0',
      id: requestId,
      error: { code, message }
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
    it('sends a JSON-RPC request and resolves on response', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })

      // Verify the request was written
      expect(transport.written.length).toBe(1)
      const frame = transport.written[0]
      expect(frame[0]).toBe(MessageType.Regular)

      const payloadLen = frame.readUInt32BE(9)
      const payload = JSON.parse(
        frame.subarray(HEADER_LENGTH, HEADER_LENGTH + payloadLen).toString()
      )
      expect(payload.method).toBe('pty.spawn')
      expect(payload.id).toBe(1)

      // Simulate response from relay
      const response = makeResponseFrame(1, { id: 'pty-1' }, 1)
      transport.dataCallbacks[0](response)

      const result = await promise
      expect(result).toEqual({ id: 'pty-1' })
    })

    it('rejects on error response', async () => {
      const promise = mux.request('pty.spawn', { cols: 80, rows: 24 })

      const response = makeErrorResponseFrame(1, -33004, 'PTY allocation failed', 1)
      transport.dataCallbacks[0](response)

      await expect(promise).rejects.toThrow('PTY allocation failed')
    })

    it('times out after 30s with no response', async () => {
      const promise = mux.request('pty.spawn')

      // Feed keepalive frames periodically to prevent the connection-level
      // timeout (20s no-data) from firing before the 30s request timeout.
      for (let i = 0; i < 6; i++) {
        vi.advanceTimersByTime(5_000)
        transport.dataCallbacks[0](encodeKeepAliveFrame(i + 1, 0))
      }
      vi.advanceTimersByTime(1_000)

      await expect(promise).rejects.toThrow('timed out')
      const cancelPayload = JSON.parse(
        transport.written
          .at(-1)!
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written.at(-1)!.readUInt32BE(9))
          .toString()
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

    it('assigns unique request IDs', async () => {
      void mux.request('method1').catch(() => {})
      void mux.request('method2').catch(() => {})

      expect(transport.written.length).toBe(2)
      const id1 = JSON.parse(
        transport.written[0]
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written[0].readUInt32BE(9))
          .toString()
      ).id
      const id2 = JSON.parse(
        transport.written[1]
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written[1].readUInt32BE(9))
          .toString()
      ).id
      expect(id1).not.toBe(id2)
    })
  })

  describe('notifications', () => {
    it('sends notifications without expecting a response', () => {
      mux.notify('pty.data', { id: 'pty-1', data: 'hello' })

      expect(transport.written.length).toBe(1)
      const payload = JSON.parse(
        transport.written[0]
          .subarray(HEADER_LENGTH, HEADER_LENGTH + transport.written[0].readUInt32BE(9))
          .toString()
      )
      expect(payload.method).toBe('pty.data')
      expect(payload.id).toBeUndefined()
    })

    it('dispatches incoming notifications to handler', () => {
      const handler = vi.fn()
      mux.onNotification(handler)

      const frame = makeNotificationFrame('pty.exit', { id: 'pty-1', code: 0 }, 1)
      transport.dataCallbacks[0](frame)

      expect(handler).toHaveBeenCalledWith('pty.exit', { id: 'pty-1', code: 0 })
    })

    it('typed dispatcher only fires for its method', () => {
      const chunkHandler = vi.fn()
      const otherHandler = vi.fn()
      const generic = vi.fn()
      mux.onNotificationByMethod('fs.streamChunk', chunkHandler)
      mux.onNotificationByMethod('fs.streamEnd', otherHandler)
      mux.onNotification(generic)

      transport.dataCallbacks[0](
        makeNotificationFrame('fs.streamChunk', { streamId: 1, seq: 0, data: 'aGk=' }, 1)
      )

      expect(chunkHandler).toHaveBeenCalledWith({ streamId: 1, seq: 0, data: 'aGk=' })
      expect(otherHandler).not.toHaveBeenCalled()
      expect(generic).toHaveBeenCalledWith('fs.streamChunk', {
        streamId: 1,
        seq: 0,
        data: 'aGk='
      })
    })

    it('typed dispatcher unsubscribe removes only that handler', () => {
      const a = vi.fn()
      const b = vi.fn()
      const unsubA = mux.onNotificationByMethod('fs.streamEnd', a)
      mux.onNotificationByMethod('fs.streamEnd', b)
      unsubA()

      transport.dataCallbacks[0](makeNotificationFrame('fs.streamEnd', { streamId: 7 }, 1))

      expect(a).not.toHaveBeenCalled()
      expect(b).toHaveBeenCalledWith({ streamId: 7 })
    })
  })

  describe('keepalive', () => {
    it('sends keepalive frames periodically', () => {
      const initialWrites = transport.written.length

      vi.advanceTimersByTime(5_000)
      expect(transport.written.length).toBeGreaterThan(initialWrites)

      const lastFrame = transport.written.at(-1)!
      expect(lastFrame[0]).toBe(MessageType.KeepAlive)
    })

    it('turns transport write failures into connection loss instead of throwing from the timer', () => {
      const writeError = new Error('write EPIPE')
      transport.write = vi.fn(() => {
        throw writeError
      })

      expect(() => vi.advanceTimersByTime(5_000)).not.toThrow()
      expect(mux.isDisposed()).toBe(true)
    })
  })

  describe('dispose', () => {
    it('rejects all pending requests on dispose', async () => {
      const promise = mux.request('pty.spawn')

      mux.dispose()

      await expect(promise).rejects.toThrow('Multiplexer disposed')
    })

    it('throws on request after dispose', async () => {
      mux.dispose()

      await expect(mux.request('pty.spawn')).rejects.toThrow('Multiplexer disposed')
    })

    it('ignores notify after dispose', () => {
      mux.dispose()
      mux.notify('pty.data', { id: 'pty-1', data: 'x' })
      // No writes should happen after the initial keepalive writes
    })

    it('reports isDisposed correctly', () => {
      expect(mux.isDisposed()).toBe(false)
      mux.dispose()
      expect(mux.isDisposed()).toBe(true)
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
