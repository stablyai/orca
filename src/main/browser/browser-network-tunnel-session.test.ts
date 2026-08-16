import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelOpen,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../shared/browser-network-tunnel-protocol'
import {
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'
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
  it('opens the exact remote DNS target and grants bounded receive credit', () => {
    const socket = new FakeSocket()
    const connect = vi.fn(() => socket)
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })

    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'split-horizon.internal', port: 443 })
      )
    )
    socket.emit('connect')

    expect(connect).toHaveBeenCalledWith({ host: 'split-horizon.internal', port: 443 })
    expect(socket.paused).toBe(true)
    expect(sent.map(decodeBrowserNetworkTunnelFrame)).toEqual([
      expect.objectContaining({ opcode: BrowserNetworkTunnelOpcode.Opened, streamId: 3 }),
      expect.objectContaining({ opcode: BrowserNetworkTunnelOpcode.WindowUpdate, streamId: 3 })
    ])
    const credit = decodeBrowserNetworkTunnelFrame(sent[1]!)
    expect(credit && decodeBrowserNetworkTunnelWindowUpdate(credit.payload)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
  })

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

  it('does not read destination bytes before the client grants credit', () => {
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

    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(3))
    )
    socket.emit('data', new Uint8Array([4, 5, 6, 7]))

    const first = decodeBrowserNetworkTunnelFrame(sent[0]!)
    expect(first?.opcode).toBe(BrowserNetworkTunnelOpcode.Data)
    expect(first?.payload).toEqual(new Uint8Array([4, 5, 6]))
    expect(socket.paused).toBe(true)

    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    const second = decodeBrowserNetworkTunnelFrame(sent[1]!)
    expect(second?.payload).toEqual(new Uint8Array([7]))
  })

  it('fences stale generations and closes every stream on disposal', () => {
    const socket = new FakeSocket()
    const connect = vi.fn(() => socket)
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })

    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'stale.internal', port: 80 }),
        3,
        6
      )
    )
    expect(connect).not.toHaveBeenCalled()

    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'current.internal', port: 80 })
      )
    )
    session.close()

    expect(socket.destroyed).toBe(true)
  })

  it('rejects stream reuse without replacing the original destination', () => {
    const firstSocket = new FakeSocket()
    const secondSocket = new FakeSocket()
    const connect = vi.fn().mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket)
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const open = (host: string): void =>
      session.handleBinary(
        frame(BrowserNetworkTunnelOpcode.Open, encodeBrowserNetworkTunnelOpen({ host, port: 80 }))
      )

    open('first.internal')
    open('second.internal')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(firstSocket.destroyed).toBe(true)
    expect(secondSocket.destroyed).toBe(false)
    const error = decodeBrowserNetworkTunnelFrame(sent.at(-1)!)
    expect(error?.opcode).toBe(BrowserNetworkTunnelOpcode.Error)
    expect(error ? new TextDecoder().decode(error.payload) : '').toBe('stream_id_reused')
  })

  it('rejects current-generation frames for unknown and retired stream IDs', () => {
    const socket = new FakeSocket()
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const connect = vi.fn(() => socket)
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const open = frame(
      BrowserNetworkTunnelOpcode.Open,
      encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
    )

    session.handleBinary(open)
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close))
    session.handleBinary(open)

    expect(connect).toHaveBeenCalledTimes(1)
    expect(socket.destroyed).toBe(true)
    expect(decodeBrowserNetworkTunnelFrame(sent.at(-1)!)?.opcode).toBe(
      BrowserNetworkTunnelOpcode.Error
    )

    const otherSocket = new FakeSocket()
    const unknownSession = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => otherSocket,
      sendBinary: () => true
    })
    unknownSession.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
      )
    )
    unknownSession.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1]), 4))
    expect(otherSocket.destroyed).toBe(true)
  })

  it('accepts unused out-of-order stream IDs without permitting reuse', () => {
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

    open(5)
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), 5))
    open(3)

    expect(connect).toHaveBeenCalledTimes(2)
    expect(secondSocket.destroyed).toBe(false)
  })

  it('fences invalid half-close transitions and emits destination EOF once', () => {
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
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.HalfClose))
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1])))
    expect(socket.ended).toBe(true)
    expect(socket.destroyed).toBe(true)

    const responseSocket = new FakeSocket()
    const responseFrames: Uint8Array<ArrayBufferLike>[] = []
    const responseSession = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => responseSocket,
      sendBinary: (bytes) => {
        responseFrames.push(bytes)
        return true
      }
    })
    responseSession.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
      )
    )
    responseSocket.emit('connect')
    responseFrames.length = 0
    responseSession.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    responseSocket.emit('data', new Uint8Array([1]))
    responseSocket.emit('end')
    responseSession.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    expect(
      responseFrames
        .map(decodeBrowserNetworkTunnelFrame)
        .filter((item) => item?.opcode === BrowserNetworkTunnelOpcode.HalfClose)
    ).toHaveLength(1)
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

  it('fails closed on pre-connect credit and synchronous transport failure', () => {
    const socket = new FakeSocket()
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => socket,
      sendBinary: () => true
    })
    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
      )
    )
    session.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))
    )
    expect(socket.destroyed).toBe(true)

    const throwingSocket = new FakeSocket()
    const throwingSession = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => throwingSocket,
      sendBinary: () => {
        throw new Error('transport closed')
      }
    })
    throwingSession.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'localhost', port: 80 })
      )
    )
    expect(() => throwingSocket.emit('connect')).not.toThrow()
    expect(throwingSocket.destroyed).toBe(true)
  })

  it('closes a stream that exceeds its receive window', () => {
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
    const chunk = new Uint8Array(64 * 1024)
    for (let index = 0; index < 4; index += 1) {
      session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, chunk))
    }
    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1])))

    expect(socket.destroyed).toBe(true)
    expect(decodeBrowserNetworkTunnelFrame(sent.at(-1)!)?.opcode).toBe(
      BrowserNetworkTunnelOpcode.Error
    )
  })
})
