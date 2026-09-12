import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode as Op,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate,
  decodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

const sessions: BrowserNetworkTunnelSession[] = []
afterEach(() => {
  for (const session of sessions.splice(0)) {
    session.close()
  }
})

function fixture() {
  const writes: ((error?: Error | null) => void)[] = []
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    setNoDelay: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(() => {
      socket.destroyed = true
      return socket
    }),
    write: vi.fn((_bytes, callback) => {
      writes.push(callback)
      return true
    })
  })
  const sent: Uint8Array[] = []
  const connect = vi.fn(() => socket as unknown as BrowserNetworkTunnelSocket)
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 7,
    connect,
    sendBinary: (bytes) => {
      sent.push(Uint8Array.from(bytes))
      return true
    }
  })
  sessions.push(session)
  const send = (
    opcode: Op,
    payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
    streamId = 1
  ) =>
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, streamId, tunnelGeneration: 7 })
    )
  const open = (id = 1) =>
    send(Op.Open, encodeBrowserNetworkTunnelOpen({ host: 'remote.internal', port: 443 }), id)
  const publication = { drain: vi.fn(async () => {}), assertDrained: vi.fn() }
  return { socket, writes, sent, connect, session, send, open, publication }
}

it('refuses new opens without closing an admitted pending connection', async () => {
  const f = fixture()
  f.open()
  const fence = f.session.fenceForDrain(f.publication)
  f.open(2)
  expect(f.connect).toHaveBeenCalledTimes(1)
  expect(f.socket.destroy).not.toHaveBeenCalled()
  expect(decodeBrowserNetworkTunnelFrame(f.sent.at(-1)!)).toMatchObject({
    opcode: Op.Error,
    streamId: 2
  })
  expect(fence.assertDrained).toThrow('not_drained')
  f.socket.emit('connect')
  f.socket.emit('end')
  f.socket.emit('close')
  await fence.drain(new AbortController().signal)
  expect(f.publication.drain).toHaveBeenCalledOnce()
})

it('does not count stream removal or destroy as physical socket closure', async () => {
  const f = fixture()
  f.open()
  f.socket.emit('connect')
  const fence = f.session.fenceForDrain(f.publication)
  f.send(Op.Close)
  expect(f.socket.destroy).toHaveBeenCalled()
  expect(fence.assertDrained).toThrow('not_drained')
  f.socket.emit('close')
  await fence.drain(new AbortController().signal)
})

it('waits for destination write callbacks even after physical close', async () => {
  const f = fixture()
  f.open()
  f.socket.emit('connect')
  f.send(Op.Data, Buffer.from('request'))
  const fence = f.session.fenceForDrain(f.publication)
  f.socket.emit('end')
  f.socket.emit('close')
  expect(fence.assertDrained).toThrow('not_drained')
  expect(
    f.sent.map(decodeBrowserNetworkTunnelFrame).some((frame) => frame?.opcode === Op.Close)
  ).toBe(false)
  f.writes[0]!()
  await fence.drain(new AbortController().signal)
})

it('retains output through close until peer credit allows the buffered tail to publish', async () => {
  const f = fixture()
  f.open()
  f.socket.emit('connect')
  const fence = f.session.fenceForDrain(f.publication)
  f.socket.emit('data', Buffer.from('tail'))
  f.socket.emit('end')
  f.socket.emit('close')
  expect(fence.assertDrained).toThrow('not_drained')
  f.send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(4))
  await fence.drain(new AbortController().signal)
  const frames = f.sent.map(decodeBrowserNetworkTunnelFrame)
  expect(frames.slice(-3).map((frame) => frame?.opcode)).toEqual([Op.Data, Op.HalfClose, Op.Close])
  expect(Buffer.from(frames.at(-3)!.payload).toString()).toBe('tail')
})

it('requires publication settlement after local resources finish', async () => {
  const f = fixture()
  const published = Promise.withResolvers<void>()
  f.publication.drain.mockReturnValue(published.promise)
  const fence = f.session.fenceForDrain(f.publication)
  const complete = vi.fn()
  const draining = fence.drain(new AbortController().signal).then(complete)
  await Promise.resolve()
  expect(complete).not.toHaveBeenCalled()
  published.resolve()
  await draining
  expect(complete).toHaveBeenCalledOnce()
})

it('wakes a publication wait when transport closure makes drain unverifiable', async () => {
  const f = fixture()
  f.publication.drain.mockReturnValue(new Promise(() => {}))
  const fence = f.session.fenceForDrain(f.publication)
  const draining = fence.drain(new AbortController().signal).catch((error: unknown) => error)
  await Promise.resolve()
  f.session.close()
  expect(await draining).toMatchObject({ message: 'browser_tunnel_closed_during_drain' })
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('closed_during_drain')
})

it('retains write failure rather than turning callback completion into successful drain', async () => {
  const f = fixture()
  f.open()
  f.socket.emit('connect')
  f.send(Op.Data, Buffer.from('request'))
  const fence = f.session.fenceForDrain(f.publication)
  const failure = new Error('write failed')
  f.writes[0]!(failure)
  f.socket.emit('close')
  await expect(fence.drain(new AbortController().signal)).rejects.toBe(failure)
})

it('aborting observation neither closes sockets nor reopens admission', async () => {
  const f = fixture()
  f.open()
  const fence = f.session.fenceForDrain(f.publication)
  const observer = new AbortController()
  const draining = fence.drain(observer.signal).catch((error: unknown) => error)
  const stopped = new Error('observer stopped')
  observer.abort(stopped)
  expect(await draining).toBe(stopped)
  expect(f.socket.destroy).not.toHaveBeenCalled()
  f.open(2)
  expect(f.connect).toHaveBeenCalledOnce()
  f.socket.emit('connect')
  f.socket.emit('close')
  await fence.drain(new AbortController().signal)
})

it('refuses drain when peer retirement discards an unsent output tail', async () => {
  const f = fixture()
  f.open()
  f.socket.emit('connect')
  f.socket.emit('data', Buffer.from('retained tail'))
  const fence = f.session.fenceForDrain(f.publication)
  f.send(Op.Close)
  f.socket.emit('close')
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('retired_unsettled_data')
})

it('retains publication failure across retries even after the transport barrier later passes', async () => {
  const f = fixture()
  const failure = new Error('publication failed')
  f.publication.drain.mockRejectedValueOnce(failure)
  const fence = f.session.fenceForDrain(f.publication)
  await expect(fence.drain(new AbortController().signal)).rejects.toBe(failure)
  await expect(fence.drain(new AbortController().signal)).rejects.toBe(failure)
  expect(f.publication.drain).toHaveBeenCalledOnce()
})
