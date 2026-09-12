import { EventEmitter, once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import {
  BrowserNetworkTunnelOpcode as Op,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'

function nativeSocket() {
  const socket = Object.assign(new EventEmitter(), {
    destroyed: false,
    setNoDelay: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    end: vi.fn(),
    write: vi.fn((_bytes, callback) => {
      callback?.()
      return true
    }),
    destroy: vi.fn(() => {
      socket.destroyed = true
      return socket
    })
  })
  return socket
}

const publication = () => ({ drain: async () => {}, assertDrained: () => {} })

it('accounts before synchronous peer acknowledgments and prevents reentrant duplicate publication', async () => {
  const socket = Object.assign(nativeSocket(), { settleRead: vi.fn() })
  const payloads: string[] = []
  let session!: BrowserNetworkTunnelSession
  const send = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) =>
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, tunnelGeneration: 1, streamId: 1 })
    )
  session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => socket as unknown as BrowserNetworkTunnelSocket,
    sendBinary: (bytes) => {
      const frame = decodeBrowserNetworkTunnelFrame(bytes)!
      if (frame.opcode === Op.Data) {
        payloads.push(Buffer.from(frame.payload).toString())
        send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(frame.payload.byteLength))
      }
      return true
    }
  })
  socket.settleRead.mockImplementationOnce(() => socket.emit('data', Buffer.from('two')))
  try {
    send(Op.Open, encodeBrowserNetworkTunnelOpen({ host: 'remote', port: 443 }))
    socket.emit('connect')
    send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(256 * 1024))
    const fence = session.fenceForDrain(publication())
    socket.emit('data', Buffer.from('one'))
    socket.emit('end')
    socket.emit('close')
    await fence.drain(new AbortController().signal)
    expect(payloads).toEqual(['one', 'two'])
    expect(socket.settleRead.mock.calls).toEqual([[3], [3]])
  } finally {
    session.close()
  }
})

it('retains a nested consumption callback failure rather than claiming successful drain', async () => {
  const socket = Object.assign(nativeSocket(), {
    settleRead: vi.fn(() => {
      throw new Error('inner failed')
    })
  })
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => socket as unknown as BrowserNetworkTunnelSocket,
    sendBinary: () => true
  })
  const send = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) =>
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, tunnelGeneration: 1, streamId: 1 })
    )
  try {
    send(Op.Open, encodeBrowserNetworkTunnelOpen({ host: 'remote', port: 443 }))
    socket.emit('connect')
    send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(256 * 1024))
    const fence = session.fenceForDrain(publication())
    socket.emit('data', Buffer.from('tail'))
    send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(4))
    await expect(fence.drain(new AbortController().signal)).rejects.toThrow(
      'consumption_settlement_failed'
    )
  } finally {
    session.close()
  }
})

it('settles the inner tunnel only from outer consumption, including the final tail', async () => {
  const destination = nativeSocket()
  let innerClient!: BrowserNetworkTunnelClient
  const innerSession = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => destination as unknown as BrowserNetworkTunnelSocket,
    sendBinary: (bytes) => {
      innerClient.handleBinary(bytes)
      return true
    }
  })
  innerClient = new BrowserNetworkTunnelClient({
    tunnelGeneration: 1,
    sendBinary: (bytes) => {
      innerSession.handleBinary(bytes)
      return true
    }
  })
  let outerClient!: BrowserNetworkTunnelClient
  const outerSession = new BrowserNetworkTunnelSession({
    tunnelGeneration: 2,
    connect: (target) => {
      const deferred = new BrowserNetworkDeferredSocket()
      void innerClient.open(target).then(
        (source) => deferred.attach(source),
        (error) => deferred.fail(error)
      )
      return deferred
    },
    sendBinary: (bytes) => {
      outerClient.handleBinary(bytes)
      return true
    }
  })
  outerClient = new BrowserNetworkTunnelClient({
    tunnelGeneration: 2,
    sendBinary: (bytes) => {
      outerSession.handleBinary(bytes)
      return true
    }
  })
  try {
    const opening = outerClient.open({ host: 'remote.internal', port: 443 })
    destination.emit('connect')
    const socket = await opening
    const received: Buffer[] = []
    socket.on('data', (bytes) => received.push(bytes))
    const innerFence = innerClient.fenceForDrain(publication())
    const outerFence = outerSession.fenceForDrain(publication())
    const clientFence = outerClient.fenceForDrain(publication())
    const ended = once(socket, 'end')
    destination.emit('data', Buffer.from('lasttail'))
    destination.emit('end')
    destination.emit('close')
    await ended
    expect(Buffer.concat(received).toString()).toBe('lasttail')
    expect(innerFence.assertDrained).toThrow('not_drained')
    expect(outerFence.assertDrained).toThrow('not_drained')
    socket.settleRead(3)
    expect(innerFence.assertDrained).toThrow('not_drained')
    socket.settleRead(5)
    await Promise.all([
      innerFence.drain(new AbortController().signal),
      outerFence.drain(new AbortController().signal),
      clientFence.drain(new AbortController().signal)
    ])
  } finally {
    outerClient.close()
    outerSession.close()
    innerClient.close()
    innerSession.close()
  }
})

it('does not mistake initial credit or opposite-direction write completion for consumed output', () => {
  const socket = Object.assign(nativeSocket(), { settleRead: vi.fn() })
  const sent: Uint8Array<ArrayBufferLike>[] = []
  const session = new BrowserNetworkTunnelSession({
    tunnelGeneration: 1,
    connect: () => socket as unknown as BrowserNetworkTunnelSocket,
    sendBinary: (bytes) => {
      sent.push(bytes)
      return true
    }
  })
  const send = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) =>
    session.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, tunnelGeneration: 1, streamId: 1 })
    )
  try {
    send(Op.Open, encodeBrowserNetworkTunnelOpen({ host: 'remote', port: 443 }))
    socket.emit('connect')
    send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(256 * 1024))
    send(Op.Data, Buffer.from('request'))
    expect(socket.settleRead).not.toHaveBeenCalled()
    socket.emit('data', Buffer.from('reply'))
    socket.emit('end')
    socket.emit('close')
    expect(
      sent.map(decodeBrowserNetworkTunnelFrame).some((frame) => frame?.opcode === Op.Close)
    ).toBe(false)
    send(Op.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(5))
    expect(socket.settleRead).toHaveBeenCalledExactlyOnceWith(5)
    expect(decodeBrowserNetworkTunnelFrame(sent.at(-1)!)?.opcode).toBe(Op.Close)
  } finally {
    session.close()
  }
})
