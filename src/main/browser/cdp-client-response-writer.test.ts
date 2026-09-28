import { once } from 'node:events'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { CdpClientResponseWriter } from './cdp-client-response-writer'

const MiB = 1024 * 1024

describe('CDP outbound backpressure', () => {
  let server: WebSocketServer
  let peer: WebSocket
  let socket: WebSocket
  let writer: CdpClientResponseWriter

  beforeEach(async () => {
    server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address')
    }
    const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve))
    peer = new WebSocket(`ws://127.0.0.1:${address.port}`)
    await once(peer, 'open')
    socket = await accepted
    writer = new CdpClientResponseWriter(() => socket)
  })

  afterEach(async () => {
    writer.forgetClient(socket)
    vi.useRealTimers()
    vi.restoreAllMocks()
    socket.terminate()
    peer.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('drains replies and events in order with their original session correlation', () => {
    vi.useFakeTimers()
    const buffered = vi.spyOn(socket, 'bufferedAmount', 'get').mockReturnValue(9 * MiB)
    const send = vi.spyOn(socket, 'send').mockImplementation(() => {})
    writer.recordRequestSessionId(socket, 7, { sessionId: 'session-one' })
    writer.sendResult(7, { ok: true })
    writer.send({ method: 'Page.loadEventFired', sessionId: 'session-one' })
    writer.recordRequestSessionId(socket, 8, { sessionId: 'session-two' })
    writer.sendError(8, 'failed')
    expect(send).not.toHaveBeenCalled()

    buffered.mockReturnValue(0)
    vi.advanceTimersByTime(25)
    expect(send.mock.calls.map(([frame]) => JSON.parse(String(frame)))).toEqual([
      { id: 7, result: { ok: true }, sessionId: 'session-one' },
      { method: 'Page.loadEventFired', sessionId: 'session-one' },
      { id: 8, error: { code: -32000, message: 'failed' }, sessionId: 'session-two' }
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['forget', 'close'] as const)('releases a parked queue on %s', (boundary) => {
    vi.useFakeTimers()
    const initialCloseListeners = socket.listenerCount('close')
    const buffered = vi.spyOn(socket, 'bufferedAmount', 'get').mockReturnValue(9 * MiB)
    const send = vi.spyOn(socket, 'send').mockImplementation(() => {})
    writer.sendResult(1, { value: 'abandoned' })
    expect(vi.getTimerCount()).toBe(1)
    if (boundary === 'forget') {
      writer.forgetClient(socket)
    } else {
      socket.emit('close', 1000, Buffer.alloc(0))
    }
    buffered.mockReturnValue(0)
    vi.advanceTimersByTime(100)
    expect(send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(socket.listenerCount('close')).toBeLessThanOrEqual(initialCloseListeners)
  })

  it('preserves a single large reply on a clear connection', () => {
    const send = vi.spyOn(socket, 'send').mockImplementation(() => {})
    writer.sendResult(1, { data: 'x'.repeat(65 * MiB) })
    expect(send).toHaveBeenCalledOnce()
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })

  it('terminates a real stalled reader before native buffering follows all produced bytes', async () => {
    peer.pause()
    const payload = 'x'.repeat(64 * 1024)
    let peakBuffered = 0
    for (let index = 0; index < 2048; index++) {
      writer.send({ method: 'Runtime.consoleAPICalled', params: { data: payload } })
      peakBuffered = Math.max(peakBuffered, socket.bufferedAmount)
      if (index % 16 === 0) {
        await nextTurn()
      }
      if (socket.readyState !== WebSocket.OPEN) {
        break
      }
    }
    expect(peakBuffered).toBeLessThan(9 * MiB)
    expect(socket.readyState).not.toBe(WebSocket.OPEN)
  })

  it('delivers a transient burst completely to a reading client', async () => {
    const frames: string[] = []
    const allReceived = new Promise<void>((resolve) => {
      peer.on('message', (frame) => {
        frames.push(frame.toString())
        if (frames.length === 192) {
          resolve()
        }
      })
    })
    const payload = 'y'.repeat(64 * 1024)
    for (let index = 0; index < 192; index++) {
      writer.sendResult(index, { data: payload })
    }
    await allReceived
    expect(frames).toEqual(
      Array.from({ length: 192 }, (_, id) => JSON.stringify({ id, result: { data: payload } }))
    )
    expect(socket.readyState).toBe(WebSocket.OPEN)
  })
})
