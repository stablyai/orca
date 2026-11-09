import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../../../shared/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import { BrowserNetworkTunnelSession } from './browser-network-tunnel-session'

class FakeSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  readonly writes: Uint8Array<ArrayBufferLike>[] = []
  readonly writeCallbacks: (() => void)[] = []
  destroyed = false
  paused = false
  ended = false

  setNoDelay(): this {
    return this
  }

  pause(): this {
    this.paused = true
    return this
  }

  resume(): this {
    this.paused = false
    return this
  }

  write(bytes: Uint8Array<ArrayBufferLike>, callback?: () => void): boolean {
    this.writes.push(bytes.slice())
    if (callback) {
      this.writeCallbacks.push(callback)
    }
    return true
  }

  end(): this {
    this.ended = true
    return this
  }

  destroy(): this {
    this.destroyed = true
    return this
  }
}

function frame(
  opcode: BrowserNetworkTunnelOpcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  streamId = 3,
  tunnelGeneration = 7
): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({ opcode, tunnelGeneration, streamId, payload })
}

describe('BrowserNetworkTunnelSession', () => {
  it('replenishes client credit only after the destination write settles', () => {
    const socket = new FakeSocket()
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => socket,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 8080 })
      )
    )
    socket.emit('connect')
    sent.length = 0

    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1, 2, 3])))

    expect(socket.writes).toEqual([new Uint8Array([1, 2, 3])])
    expect(sent).toEqual([])

    socket.writeCallbacks[0]?.()
    const update = decodeBrowserNetworkTunnelFrame(sent[0]!)
    expect(update?.opcode).toBe(BrowserNetworkTunnelOpcode.WindowUpdate)
    expect(update && decodeBrowserNetworkTunnelWindowUpdate(update.payload)).toBe(3)
  })

  it('keeps concurrent streams alive when late data arrives for a retired stream', () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const connect = vi.fn().mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: () => true
    })
    const open = (streamId: number): void =>
      session.handleBinary(
        frame(
          BrowserNetworkTunnelOpcode.Open,
          encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 }),
          streamId
        )
      )

    open(1)
    open(2)
    firstSocket.emit('connect')
    secondSocket.emit('connect')
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), 1))
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1]), 1))

    expect(firstSocket.destroyed).toBe(true)
    expect(secondSocket.destroyed).toBe(false)
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([2]), 2))
    expect(secondSocket.writes).toEqual([new Uint8Array([2])])
    session.close()
  })

  it('flushes credited destination bytes before close', () => {
    const socket = new FakeSocket()
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => socket,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
      )
    )
    socket.emit('connect')
    sent.length = 0
    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    socket.emit('data', new Uint8Array([1, 2]))
    socket.emit('end')
    socket.emit('close')

    expect(socket.destroyed).toBe(false)
    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    const decoded = sent.map(decodeBrowserNetworkTunnelFrame)
    expect(decoded.filter((item) => item?.opcode === BrowserNetworkTunnelOpcode.Data)).toEqual([
      expect.objectContaining({ payload: new Uint8Array([1]) }),
      expect.objectContaining({ payload: new Uint8Array([2]) })
    ])
    expect(decoded.at(-1)?.opcode).toBe(BrowserNetworkTunnelOpcode.Close)
    expect(socket.destroyed).toBe(true)
  })

  it('caps aggregate retained destination bytes and releases exact stream accounting', () => {
    const sockets: FakeSocket[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      sendBinary: () => true
    })
    const openAndBuffer = (streamId: number): void => {
      session.handleBinary(
        frame(
          BrowserNetworkTunnelOpcode.Open,
          encodeBrowserNetworkTunnelOpen({ host: 'non-reading.internal', port: 443 }),
          streamId
        )
      )
      sockets.at(-1)!.emit('connect')
      sockets.at(-1)!.emit('data', new Uint8Array(256 * 1024))
    }

    for (let streamId = 1; streamId <= 32; streamId += 1) {
      openAndBuffer(streamId)
    }
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), 1))
    openAndBuffer(33)
    expect(sockets[32]!.destroyed).toBe(false)

    openAndBuffer(34)
    expect(sockets[33]!.destroyed).toBe(true)
    expect(sockets.slice(1, 33).some((socket) => socket.destroyed)).toBe(false)
  })

  it('caps unsettled destination writes and releases retirement exactly once', () => {
    const sockets: FakeSocket[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      sendBinary: () => true
    })
    const openAndWrite = (streamId: number): void => {
      session.handleBinary(
        frame(
          BrowserNetworkTunnelOpcode.Open,
          encodeBrowserNetworkTunnelOpen({ host: 'non-writing.internal', port: 443 }),
          streamId
        )
      )
      sockets.at(-1)!.emit('connect')
      for (let index = 0; index < 4; index += 1) {
        session.handleBinary(
          frame(
            BrowserNetworkTunnelOpcode.Data,
            new Uint8Array(BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES),
            streamId
          )
        )
      }
    }

    for (let streamId = 1; streamId <= 32; streamId += 1) {
      openAndWrite(streamId)
    }
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), 1))
    for (const callback of sockets[0]!.writeCallbacks) {
      callback()
    }
    openAndWrite(33)
    expect(sockets[32]!.destroyed).toBe(false)

    openAndWrite(34)
    expect(sockets[33]!.destroyed).toBe(true)
    expect(sockets.slice(1, 33).some((socket) => socket.destroyed)).toBe(false)
  })

  it('releases queued bytes once when an accepted send closes reentrantly', () => {
    const socket = new FakeSocket()
    let closeOnData = false
    let session: BrowserNetworkTunnelSession
    session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => socket,
      sendBinary: (bytes) => {
        if (
          closeOnData &&
          decodeBrowserNetworkTunnelFrame(bytes)?.opcode === BrowserNetworkTunnelOpcode.Data
        ) {
          session.close()
        }
        return true
      }
    })
    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'reentrant.internal', port: 443 })
      )
    )
    socket.emit('connect')
    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )

    closeOnData = true
    expect(() => socket.emit('data', new Uint8Array([1]))).not.toThrow()
    expect(socket.destroyed).toBe(true)
  })
})
