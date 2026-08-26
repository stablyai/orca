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

  it('rejects current-generation frames for never-reserved and reused stream IDs', () => {
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

  it('bounds pending opens and restores admission after connect or retirement', () => {
    const sockets = Array.from({ length: 19 }, () => new FakeSocket())
    let nextSocket = 0
    const connect = vi.fn(() => sockets[nextSocket++]!)
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const open = (streamId: number): void =>
      session.handleBinary(
        frame(
          BrowserNetworkTunnelOpcode.Open,
          encodeBrowserNetworkTunnelOpen({ host: 'slow.internal', port: 443 }),
          streamId
        )
      )

    for (let streamId = 1; streamId <= 17; streamId += 1) {
      open(streamId)
    }
    expect(connect).toHaveBeenCalledTimes(16)
    expect(new TextDecoder().decode(decodeBrowserNetworkTunnelFrame(sent.at(-1)!)?.payload)).toBe(
      'pending_open_limit_exceeded'
    )

    sockets[0]!.emit('connect')
    open(18)
    expect(connect).toHaveBeenCalledTimes(17)

    session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), 2))
    open(19)
    expect(connect).toHaveBeenCalledTimes(18)
  })

  it('bounds the destination open rate with an injectable monotonic clock', () => {
    let now = 1_000
    const sockets: FakeSocket[] = []
    const connect = vi.fn(() => {
      const socket = new FakeSocket()
      sockets.push(socket)
      return socket
    })
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      },
      now: () => now
    })
    const openAndClose = (streamId: number): void => {
      const socketCount = sockets.length
      session.handleBinary(
        frame(
          BrowserNetworkTunnelOpcode.Open,
          encodeBrowserNetworkTunnelOpen({ host: 'burst.internal', port: 443 }),
          streamId
        )
      )
      if (sockets.length > socketCount) {
        sockets.at(-1)!.emit('connect')
        session.handleBinary(frame(BrowserNetworkTunnelOpcode.Close, new Uint8Array(), streamId))
      }
    }

    for (let streamId = 1; streamId <= 128; streamId += 1) {
      openAndClose(streamId)
    }
    openAndClose(129)
    expect(connect).toHaveBeenCalledTimes(128)
    expect(new TextDecoder().decode(decodeBrowserNetworkTunnelFrame(sent.at(-1)!)?.payload)).toBe(
      'open_rate_exceeded'
    )

    now += 10_001
    openAndClose(130)
    expect(connect).toHaveBeenCalledTimes(129)
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

    // Exhaustion is an aggregate-resource condition, not a peer violation: only the stream that
    // could not reserve is retired, and every other stream keeps running.
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

  it('bounds unsettled destination write chunks independently of byte credit', () => {
    const socket = new FakeSocket()
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 7,
      connect: () => socket,
      sendBinary: () => true
    })
    session.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.Open,
        encodeBrowserNetworkTunnelOpen({ host: 'tiny-writes.internal', port: 443 })
      )
    )
    socket.emit('connect')

    for (let index = 0; index < 257; index += 1) {
      session.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([index & 0xff])))
    }

    expect(socket.writes).toHaveLength(256)
    expect(socket.destroyed).toBe(true)
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
