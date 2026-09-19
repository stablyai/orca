import { once } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import {
  BrowserNetworkTunnelOpcode as Op,
  encodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'

const clients: BrowserNetworkTunnelClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

function fixture() {
  const sent: Uint8Array<ArrayBufferLike>[] = []
  const client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 7,
    sendBinary: (bytes) => {
      sent.push(bytes)
      return true
    }
  })
  clients.push(client)
  const send = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) =>
    client.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, tunnelGeneration: 7, streamId: 1 })
    )
  const opening = client.open({ host: 'remote.internal', port: 443 })
  const publication = { drain: vi.fn(async () => {}), assertDrained: vi.fn() }
  return { client, sent, send, opening, publication }
}

it('waits for delayed downstream settlement after readable end and remote Close', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  const received: Buffer[] = []
  socket.on('data', (bytes) => received.push(bytes))
  const fence = f.client.fenceForDrain(f.publication)
  const ended = once(socket, 'end')
  f.send(Op.Data, Buffer.from('tail'))
  f.send(Op.Close)
  await ended
  expect(Buffer.concat(received).toString()).toBe('tail')
  expect(socket.destroyed).toBe(false)
  expect(fence.assertDrained).toThrow('not_drained')
  socket.settleRead(4)
  await fence.drain(new AbortController().signal)
  expect(socket.destroyed).toBe(true)
})

it('keeps both-half completion alive until downstream bytes settle, then sends Close', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  socket.on('data', () => {})
  socket.end()
  const fence = f.client.fenceForDrain(f.publication)
  const ended = once(socket, 'end')
  f.send(Op.Data, Buffer.from('tail'))
  f.send(Op.HalfClose)
  await ended
  expect(socket.destroyed).toBe(false)
  expect(fence.assertDrained).toThrow('not_drained')
  socket.settleRead(4)
  await fence.drain(new AbortController().signal)
  expect(decodeBrowserNetworkTunnelFrame(f.sent.at(-1)!)?.opcode).toBe(Op.Close)
})

it('handles remote Close after readable end already fired', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  socket.resume()
  const ended = once(socket, 'end')
  f.send(Op.HalfClose)
  await ended
  const fence = f.client.fenceForDrain(f.publication)
  f.send(Op.Close)
  await fence.drain(new AbortController().signal)
  expect(socket.destroyed).toBe(true)
})

it('refuses new opens while an admitted pending open can finish', async () => {
  const f = fixture()
  const fence = f.client.fenceForDrain(f.publication)
  await expect(f.client.open({ host: 'new', port: 80 })).rejects.toThrow('admission_closed')
  expect(f.sent).toHaveLength(1)
  f.send(Op.Opened)
  const socket = await f.opening
  socket.resume()
  f.send(Op.Close)
  await fence.drain(new AbortController().signal)
})

it('refuses successful drain when remote close abandons an uncredited write', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  const written = vi.fn()
  socket.write(Buffer.from('request'), written)
  const fence = f.client.fenceForDrain(f.publication)
  f.send(Op.Close)
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow(
    'remote_closed_with_pending_writes'
  )
  expect(written).toHaveBeenCalledWith(expect.any(Error))
})

it('records discarded unread data before destructive retirement clears its accounting', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  f.send(Op.Data, Buffer.from('unread'))
  const fence = f.client.fenceForDrain(f.publication)
  socket.destroy()
  await expect(fence.drain(new AbortController().signal)).rejects.toThrow('retired_unsettled_data')
})

it('preserves the fence and active stream across an aborted drain observation', async () => {
  const f = fixture()
  f.send(Op.Opened)
  const socket = await f.opening
  const fence = f.client.fenceForDrain(f.publication)
  const observer = new AbortController()
  const draining = fence.drain(observer.signal).catch((error: unknown) => error)
  const stopped = new Error('observation stopped')
  observer.abort(stopped)
  expect(await draining).toBe(stopped)
  expect(socket.destroyed).toBe(false)
  socket.resume()
  f.send(Op.Close)
  await fence.drain(new AbortController().signal)
})
