import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WebSocket } from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createFrameDecoder,
  decodeIrohFramePayload,
  encodeLengthPrefixedFrame
} from './iroh-frame-codec'
import { IrohTransport } from './iroh-transport'
import { createFakeBind, FakeRecv, FakeSend } from './iroh-transport.test-fixture'

describe('Iroh admission and authenticated communication deadlines', () => {
  const dirs: string[] = []
  const transports: IrohTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop()))
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
    vi.useRealTimers()
  })

  it('reuses admission capacity after native handshake deadlines without closing the endpoint', async () => {
    vi.useFakeTimers()
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-transport-'))
    dirs.push(userDataPath)
    const stalled = Array.from({ length: 128 }, () => {
      const fake = createFakeBind(new FakeRecv(), new FakeSend())
      fake.accepting.connect.mockImplementation(() => {
        const pending = Promise.withResolvers<typeof fake.connection>()
        setTimeout(
          () => pending.reject(new Error('incoming handshake exceeded 10 seconds')),
          10_000
        )
        return pending.promise
      })
      return fake
    })
    const endpoint = stalled[0]
    const healthy = createFakeBind(new FakeRecv(), new FakeSend())
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 60_000,
      idleTimeoutMs: 60_000,
      bindEndpoint: endpoint.bindEndpoint
    })
    transports.push(transport)
    const received = vi.fn()
    transport.onMessage(received)
    await transport.start()
    for (const fake of stalled) {
      endpoint.pushIncoming(fake.incoming)
      await vi.advanceTimersByTimeAsync(0)
      expect(fake.accepting.connect).toHaveBeenCalledOnce()
    }
    endpoint.pushIncoming(healthy.incoming)
    await vi.advanceTimersByTimeAsync(0)
    expect(healthy.incoming.refuse).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(9_999)
    endpoint.pushIncoming(healthy.incoming)
    await vi.advanceTimersByTimeAsync(0)
    expect(healthy.incoming.refuse).toHaveBeenCalledTimes(2)
    expect(healthy.incoming.accept).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(endpoint.endpoint.close).not.toHaveBeenCalled()
    for (const fake of stalled) {
      expect(fake.connection.acceptBi).not.toHaveBeenCalled()
    }

    endpoint.pushIncoming(healthy.incoming)
    healthy.bi.recv.push(
      Array.from(encodeLengthPrefixedFrame(new TextEncoder().encode('replacement peer')))
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(received.mock.calls[0]?.[0]).toBe('replacement peer')
    expect(healthy.incoming.accept).toHaveBeenCalledOnce()
    await transport.stop()
    expect(healthy.connection.close).toHaveBeenCalledOnce()
    expect(endpoint.endpoint.close).toHaveBeenCalledOnce()
    expect(received).toHaveBeenCalledOnce()
  })

  async function open(send: FakeSend) {
    vi.useFakeTimers()
    const userDataPath = mkdtempSync(join(tmpdir(), 'iroh-idle-progress-'))
    dirs.push(userDataPath)
    const recv = new FakeRecv()
    const fake = createFakeBind(recv, send)
    const transport = new IrohTransport({
      userDataPath,
      preAuthTimeoutMs: 1_000,
      idleTimeoutMs: 2_000,
      bindEndpoint: fake.bindEndpoint
    })
    transports.push(transport)
    const sockets: WebSocket[] = []
    const received: unknown[] = []
    const closed = vi.fn()
    transport.onMessage((message, _reply, socket) => {
      received.push(message)
      sockets.push(socket)
    })
    transport.onConnectionClose(closed)
    await transport.start()
    fake.pushIncoming()
    recv.push(Array.from(encodeLengthPrefixedFrame(Buffer.from('hello'))))
    await vi.advanceTimersByTimeAsync(0)
    expect(received).toEqual(['hello'])
    return { transport, recv, fake, received, closed, socket: sockets[0]! }
  }

  it('renews only for authentication and completed native progress, then expires a stalled writer', async () => {
    const outbound: unknown[] = []
    const decoder = createFrameDecoder({
      onFrame: (payload) => outbound.push(decodeIrohFramePayload(payload)),
      onOversize: () => {
        throw new Error('unexpected oversized outbound frame')
      }
    })
    const completeWrites: (() => void)[] = []
    const send = new FakeSend(async (chunk) => {
      const pending = Promise.withResolvers<void>()
      completeWrites.push(pending.resolve)
      await pending.promise
      decoder.feed(chunk)
    })
    const { transport, recv, fake, received, closed, socket } = await open(send)
    await vi.advanceTimersByTimeAsync(900)
    transport.setClientId(socket, 'active-client')
    const output = 'x'.repeat(140_000)
    socket.send(output)
    await vi.advanceTimersByTimeAsync(0)

    // One frame takes longer than the lease; every completed native chunk keeps it alive.
    for (let chunk = 0; chunk < 3; chunk += 1) {
      await vi.advanceTimersByTimeAsync(1_900)
      expect(closed).not.toHaveBeenCalled()
      completeWrites.shift()!()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(outbound).toEqual([output])

    const upload = encodeLengthPrefixedFrame(Buffer.from('partial upload'))
    for (const chunk of [
      upload.subarray(0, 2),
      upload.subarray(2, 4),
      upload.subarray(4, -1),
      upload.subarray(-1)
    ]) {
      await vi.advanceTimersByTimeAsync(1_900)
      recv.push(Array.from(chunk))
      await vi.advanceTimersByTimeAsync(0)
      expect(closed).not.toHaveBeenCalled()
    }
    expect(received).toEqual(['hello', 'partial upload'])

    socket.send('blocked')
    socket.send('queued')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(closed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(closed).toHaveBeenCalledExactlyOnceWith('active-client', socket, false)
    expect(fake.connection.close).toHaveBeenCalledOnce()
    completeWrites.shift()!()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(outbound).toEqual([output, 'blocked'])
    expect(closed).toHaveBeenCalledOnce()
  })

  it('does not let unauthenticated partial reads or successful writes extend the auth deadline', async () => {
    const outbound: unknown[] = []
    const decoder = createFrameDecoder({
      onFrame: (payload) => outbound.push(decodeIrohFramePayload(payload)),
      onOversize: () => {
        throw new Error('unexpected oversized challenge')
      }
    })
    const { recv, received, closed, socket } = await open(
      new FakeSend((chunk) => decoder.feed(chunk))
    )
    const upload = encodeLengthPrefixedFrame(Buffer.from('unfinished auth'))
    await vi.advanceTimersByTimeAsync(400)
    recv.push(Array.from(upload.subarray(0, 2)))
    socket.send('challenge one')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(400)
    recv.push(Array.from(upload.subarray(2, 4)))
    socket.send('challenge two')
    await vi.advanceTimersByTimeAsync(0)
    expect(outbound).toEqual(['challenge one', 'challenge two'])
    await vi.advanceTimersByTimeAsync(199)
    expect(closed).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(received).toEqual(['hello'])
    expect(closed).toHaveBeenCalledExactlyOnceWith(null, socket, false)
  })

  it('does not resume a partial native frame or queued writes after transport shutdown', async () => {
    const pending = Promise.withResolvers<void>()
    const outbound: unknown[] = []
    const decoder = createFrameDecoder({
      onFrame: (payload) => outbound.push(decodeIrohFramePayload(payload)),
      onOversize: () => {
        throw new Error('unexpected oversized outbound frame')
      }
    })
    const { transport, fake, closed, socket } = await open(
      new FakeSend(async (chunk) => {
        await pending.promise
        decoder.feed(chunk)
      })
    )
    transport.setClientId(socket, 'stopped-client')
    socket.send('x'.repeat(140_000))
    socket.send('queued')
    await vi.advanceTimersByTimeAsync(0)
    await transport.stop()
    pending.resolve()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(outbound).toEqual([])
    expect(socket.readyState).toBe(3)
    expect(closed).toHaveBeenCalledExactlyOnceWith('stopped-client', socket, false)
    expect(fake.connection.close).toHaveBeenCalledOnce()
  })
})
