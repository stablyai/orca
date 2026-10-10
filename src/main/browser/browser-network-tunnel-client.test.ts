import { once } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES,
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelOpen,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
} from './browser-network-tunnel-stream-state'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'

function frame(
  opcode: BrowserNetworkTunnelOpcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  tunnelGeneration = 7,
  streamId = 1
): Uint8Array {
  return encodeBrowserNetworkTunnelFrame({ opcode, tunnelGeneration, streamId, payload })
}

describe('BrowserNetworkTunnelClient', () => {
  it('preserves remote DNS and waits for an opened acknowledgement', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })

    let opened = false
    const opening = client.open({ host: 'split-horizon.internal', port: 443 }).then((socket) => {
      opened = true
      return socket
    })
    await Promise.resolve()

    const open = decodeBrowserNetworkTunnelFrame(sent[0]!)
    expect(open?.opcode).toBe(BrowserNetworkTunnelOpcode.Open)
    expect(open && decodeBrowserNetworkTunnelOpen(open.payload)).toEqual({
      host: 'split-horizon.internal',
      port: 443
    })
    expect(sent).toHaveLength(1)
    expect(opened).toBe(false)

    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 6))
    await Promise.resolve()
    expect(opened).toBe(false)

    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})
    const credit = decodeBrowserNetworkTunnelFrame(sent[1]!)
    expect(credit && decodeBrowserNetworkTunnelWindowUpdate(credit.payload)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
    client.close()
  })

  it('sends only credited bytes in bounded frames and replenishes consumed input', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const opening = client.open({ host: 'localhost', port: 8080 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})
    sent.length = 0

    const outbound = Buffer.alloc(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES, 5)
    const writeCallback = vi.fn()
    socket.write(outbound, writeCallback)
    expect(sent).toEqual([])

    client.handleBinary(
      frame(
        BrowserNetworkTunnelOpcode.WindowUpdate,
        encodeBrowserNetworkTunnelWindowUpdate(BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES)
      )
    )
    const dataFrames = sent
      .map(decodeBrowserNetworkTunnelFrame)
      .filter((candidate): candidate is BrowserNetworkTunnelFrame => candidate !== null)
    expect(
      dataFrames.every((candidate) => candidate.opcode === BrowserNetworkTunnelOpcode.Data)
    ).toBe(true)
    expect(
      dataFrames.every(
        (candidate) => candidate.payload.byteLength <= BROWSER_NETWORK_TUNNEL_MAX_DATA_BYTES
      )
    ).toBe(true)
    expect(dataFrames.reduce((total, candidate) => total + candidate.payload.byteLength, 0)).toBe(
      BROWSER_NETWORK_TUNNEL_INITIAL_WINDOW_BYTES
    )
    await vi.waitFor(() => expect(writeCallback).toHaveBeenCalledOnce())

    sent.length = 0
    const tailCallback = vi.fn()
    socket.write(Buffer.alloc(17, 6), tailCallback)
    expect(tailCallback).not.toHaveBeenCalled()
    client.handleBinary(
      frame(BrowserNetworkTunnelOpcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(17))
    )
    await vi.waitFor(() => expect(tailCallback).toHaveBeenCalledOnce())

    sent.length = 0
    const received = once(socket, 'data')
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1, 2, 3])))
    await expect(received).resolves.toEqual([Buffer.from([1, 2, 3])])
    expect(sent).toEqual([])
    socket.settleRead(3)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(decodeBrowserNetworkTunnelFrame(sent[0]!)?.opcode).toBe(
      BrowserNetworkTunnelOpcode.WindowUpdate
    )
    client.close()
  })

  it('destroys every stream when the route closes or rejects a frame', async () => {
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: () => true
    })
    const firstOpening = client.open({ host: 'one.internal', port: 80 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, 1))
    const first = await firstOpening
    first.on('error', () => {})
    const secondOpening = client.open({ host: 'two.internal', port: 80 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, 2))
    const second = await secondOpening
    second.on('error', () => {})

    client.handleBinary(new Uint8Array([1, 2, 3]))

    expect(first.destroyed).toBe(true)
    expect(second.destroyed).toBe(true)
    await expect(client.open({ host: 'three.internal', port: 80 })).rejects.toThrow(
      'Browser tunnel is closed'
    )
  })

  it('retires a remotely failed stream without echoing an error or closing the route', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const opening = client.open({ host: 'refused.internal', port: 443 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    const socketError = once(socket, 'error')
    sent.length = 0

    client.handleBinary(
      frame(BrowserNetworkTunnelOpcode.Error, new TextEncoder().encode('destination_error'))
    )

    await expect(socketError).resolves.toEqual([
      expect.objectContaining({ message: 'Browser tunnel destination failed: destination_error' })
    ])
    expect(sent).toEqual([])
    const nextOpening = client.open({ host: 'healthy.internal', port: 443 })
    expect(decodeBrowserNetworkTunnelFrame(sent[0]!)?.opcode).toBe(BrowserNetworkTunnelOpcode.Open)
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, 2))
    const nextSocket = await nextOpening
    nextSocket.on('error', () => {})
    client.close()
  })

  it('rejects a destination failure before opening without an unhandled socket error', async () => {
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: () => true
    })
    const opening = client.open({ host: 'refused.internal', port: 443 })

    client.handleBinary(
      frame(BrowserNetworkTunnelOpcode.Error, new TextEncoder().encode('destination_error'))
    )

    await expect(opening).rejects.toThrow('Browser tunnel destination failed: destination_error')
    // Why: the errored destroy emits on a later tick; an unobserved 'error' fails the run here.
    await new Promise((resolve) => setImmediate(resolve))
    client.close()
  })

  it('fails a never-connected stream on timeout and notifies the remote', async () => {
    vi.useFakeTimers()
    let opening: Promise<unknown>
    const sent: Uint8Array<ArrayBufferLike>[] = []
    try {
      const client = new BrowserNetworkTunnelClient({
        tunnelGeneration: 7,
        sendBinary: (bytes) => {
          sent.push(bytes)
          return true
        }
      })
      opening = client.open({ host: 'unreachable.internal', port: 443 })
      sent.length = 0
      vi.advanceTimersByTime(BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS)
    } finally {
      vi.useRealTimers()
    }

    await expect(opening).rejects.toThrow('Browser tunnel destination connect timed out')
    expect(decodeBrowserNetworkTunnelFrame(sent[0]!)?.opcode).toBe(BrowserNetworkTunnelOpcode.Error)
    await new Promise((resolve) => setImmediate(resolve))
  })

  it('ignores a retired stream frame but rejects a never-allocated stream ID', async () => {
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: () => true
    })
    const firstOpening = client.open({ host: 'first.internal', port: 443 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const first = await firstOpening
    first.on('error', () => {})
    const firstClosed = once(first, 'close')
    first.destroy()
    await firstClosed

    const secondOpening = client.open({ host: 'second.internal', port: 443 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, 2))
    const second = await secondOpening
    second.on('error', () => {})

    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1]), 7, 1))

    expect(second.destroyed).toBe(false)
    const received = once(second, 'data')
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([2]), 7, 2))
    await expect(received).resolves.toEqual([Buffer.from([2])])
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([3]), 7, 3))
    expect(second.destroyed).toBe(true)
  })

  it('never reuses stream IDs within one generation after its bounded ledger exhausts', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      maxStreamIds: 2,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })

    for (let streamId = 1; streamId <= 2; streamId += 1) {
      const opening = client.open({ host: 'retired.internal', port: 443 })
      client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, streamId))
      const socket = await opening
      socket.on('error', () => {})
      socket.destroy()
      await once(socket, 'close')
    }

    expect(client.streamIdsExhausted).toBe(true)
    const exhausted = client.open({ host: 'next.internal', port: 443 })
    client.close()
    await expect(exhausted).rejects.toThrow('stream id limit exceeded')
    expect(
      sent
        .map(decodeBrowserNetworkTunnelFrame)
        .filter((candidate) => candidate?.opcode === BrowserNetworkTunnelOpcode.Open)
        .map((candidate) => candidate!.streamId)
    ).toEqual([1, 2])
  })

  it('withholds destination credit until a readable consumer asks for data', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const opening = client.open({ host: 'localhost', port: 8080 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})
    sent.length = 0

    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([7, 8, 9])))
    expect(sent).toEqual([])

    const received = once(socket, 'data')
    await expect(received).resolves.toEqual([Buffer.from([7, 8, 9])])
    expect(sent).toEqual([])
    socket.settleRead(3)
    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(decodeBrowserNetworkTunnelFrame(sent[0]!)?.opcode).toBe(
      BrowserNetworkTunnelOpcode.WindowUpdate
    )
    client.close()
  })

  it('replenishes only bytes settled after the readable consumer takes them', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const opening = client.open({ host: 'localhost', port: 8080 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})
    sent.length = 0

    const readable = once(socket, 'readable')
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([1, 2, 3, 4])))
    await readable
    expect(socket.read(1)).toEqual(Buffer.from([1]))
    expect(sent).toEqual([])
    socket.settleRead(1)
    expect(
      decodeBrowserNetworkTunnelWindowUpdate(decodeBrowserNetworkTunnelFrame(sent[0]!)!.payload)
    ).toBe(1)

    expect(socket.read(3)).toEqual(Buffer.from([2, 3, 4]))
    socket.settleRead(3)
    expect(
      decodeBrowserNetworkTunnelWindowUpdate(decodeBrowserNetworkTunnelFrame(sent[1]!)!.payload)
    ).toBe(3)
    client.close()
  })

  it('fails closed when pending tiny destination frames exceed the chunk cap', async () => {
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: () => true
    })
    const opening = client.open({ host: 'localhost', port: 8080 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})

    for (let index = 0; index < 257; index += 1) {
      client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([index])))
    }

    expect(socket.destroyed).toBe(true)
    await expect(client.open({ host: 'next.internal', port: 80 })).rejects.toThrow(
      'Browser tunnel is closed'
    )
  })

  it('drains data that precedes a remote close before retiring the socket', async () => {
    const sent: Uint8Array<ArrayBufferLike>[] = []
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 7,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    })
    const opening = client.open({ host: 'localhost', port: 8080 })
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened))
    const socket = await opening
    socket.on('error', () => {})
    sent.length = 0

    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Data, new Uint8Array([4, 5, 6])))
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Close))
    expect(socket.destroyed).toBe(false)

    const received: Buffer[] = []
    socket.on('data', (bytes: Buffer) => {
      received.push(bytes)
      socket.settleRead(bytes.byteLength)
    })
    await once(socket, 'end')
    await vi.waitFor(() => expect(socket.destroyed).toBe(true))
    expect(Buffer.concat(received)).toEqual(Buffer.from([4, 5, 6]))
    expect(sent).toEqual([])

    const nextOpening = client.open({ host: 'next.internal', port: 80 })
    expect(decodeBrowserNetworkTunnelFrame(sent[0]!)?.opcode).toBe(BrowserNetworkTunnelOpcode.Open)
    client.handleBinary(frame(BrowserNetworkTunnelOpcode.Opened, new Uint8Array(), 7, 2))
    const nextSocket = await nextOpening
    nextSocket.on('error', () => {})
    client.close()
  })
})
