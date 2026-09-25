import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from '../../../src/shared/browser-network-tunnel-client'
import type {
  BrowserNetworkTunnelClientSocket,
  BrowserNetworkTunnelClientSocketCallbacks
} from '../../../src/shared/browser-network-tunnel-client-socket'
import {
  BrowserNetworkTunnelOpcode as Opcode,
  decodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate
} from '../../../src/shared/browser-network-tunnel-protocol'

class ByteSocket implements BrowserNetworkTunnelClientSocket {
  destroyed = false
  received: (Uint8Array<ArrayBufferLike> | null)[] = []
  private readableEnd?: () => void

  constructor(readonly callbacks: BrowserNetworkTunnelClientSocketCallbacks) {}

  pushBytes(bytes: Uint8Array<ArrayBufferLike> | null): boolean {
    this.received.push(bytes)
    return false
  }

  onReadableEnd(callback: () => void): void {
    this.readableEnd = callback
  }

  drainEnd(): void {
    this.readableEnd?.()
    this.readableEnd = undefined
  }

  end(): void {
    this.callbacks.finishWrite(() => {})
  }

  destroy(error?: Error): void {
    this.destroyed = true
    this.callbacks.destroyStream(error ?? null, () => {})
  }
}

function frame(
  opcode: Opcode,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
  streamId = 1,
  tunnelGeneration = 7
) {
  return encodeBrowserNetworkTunnelFrame({ opcode, payload, streamId, tunnelGeneration })
}

const clients: BrowserNetworkTunnelClient<ByteSocket>[] = []
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
  vi.useRealTimers()
})

function createClient(outboundMemory?: {
  claimApplicationBytes: (bytes: number) => (() => void) | null
}) {
  const sent: Uint8Array<ArrayBufferLike>[] = []
  const client = new BrowserNetworkTunnelClient(
    {
      tunnelGeneration: 7,
      outboundMemory,
      sendBinary: (bytes) => {
        sent.push(bytes)
        return true
      }
    },
    (callbacks) => new ByteSocket(callbacks)
  )
  clients.push(client)
  const open = async (id = 1) => {
    const opening = client.open({ host: 'remote.internal', port: 443 })
    client.handleBinary(frame(Opcode.Opened, undefined, id))
    return opening
  }
  return { client, sent, open }
}

describe('portable browser tunnel adapter contract', () => {
  it('delays half-close until credited writes drain, while the read half remains usable', async () => {
    const { client, sent, open } = createClient()
    const socket = await open()
    sent.length = 0
    const written = vi.fn()
    socket.callbacks.writeBytes(new Uint8Array([1, 2, 3]), written)
    socket.end()
    expect(sent).toEqual([])
    client.handleBinary(frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(2)))
    expect(written).not.toHaveBeenCalled()
    expect(sent.map(decodeBrowserNetworkTunnelFrame).map((f) => f?.opcode)).toEqual([Opcode.Data])
    client.handleBinary(frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1)))
    expect(written).toHaveBeenCalledOnce()
    expect(sent.map(decodeBrowserNetworkTunnelFrame).map((f) => f?.opcode)).toEqual([
      Opcode.Data,
      Opcode.Data,
      Opcode.HalfClose
    ])
    socket.callbacks.requestRead()
    client.handleBinary(frame(Opcode.Data, new Uint8Array([9])))
    client.handleBinary(frame(Opcode.HalfClose))
    expect(socket.received).toEqual([new Uint8Array([9]), null])
    expect(socket.destroyed).toBe(false)
  })

  it('pauses delivery on adapter backpressure and grants credit only for settled bytes', async () => {
    const { client, sent, open } = createClient()
    const socket = await open()
    sent.length = 0
    socket.callbacks.requestRead()
    client.handleBinary(frame(Opcode.Data, new Uint8Array([1, 2])))
    client.handleBinary(frame(Opcode.Data, new Uint8Array([3])))
    client.handleBinary(frame(Opcode.HalfClose))
    expect(socket.received).toEqual([new Uint8Array([1, 2])])
    expect(sent).toEqual([])
    socket.callbacks.consumeReadBytes(1)
    expect(sent).toEqual([frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(1))])
    socket.callbacks.requestRead()
    expect(socket.received).toEqual([new Uint8Array([1, 2]), new Uint8Array([3]), null])
    expect(sent).toHaveLength(1)
    socket.callbacks.consumeReadBytes(2)
    expect(sent[1]).toEqual(frame(Opcode.WindowUpdate, encodeBrowserNetworkTunnelWindowUpdate(2)))
  })

  it('drains before remote-close retirement and releases claims once on cancellation', async () => {
    let retained = 0
    const releases: ReturnType<typeof vi.fn>[] = []
    const budget = {
      claimApplicationBytes: (bytes: number) => {
        if (retained + bytes > 6) {
          return null
        }
        retained += bytes
        const release = vi.fn(() => {
          retained -= bytes
        })
        releases.push(release)
        return release
      }
    }
    const first = createClient(budget)
    const second = createClient(budget)
    const socket = await first.open()
    const other = await second.open()
    first.client.handleBinary(frame(Opcode.Data, new Uint8Array([1, 2])))
    socket.callbacks.requestRead()
    socket.callbacks.consumeReadBytes(1)
    const pending = vi.fn()
    socket.callbacks.writeBytes(new Uint8Array([3, 4, 5]), pending)
    expect(retained).toBe(5)
    const refused = vi.fn()
    other.callbacks.writeBytes(new Uint8Array([6, 7]), refused)
    expect(refused).toHaveBeenCalledWith(expect.any(Error))
    expect(other.destroyed).toBe(true)
    expect(socket.destroyed).toBe(false)
    socket.destroy()
    expect(pending).toHaveBeenCalledWith(expect.any(Error))
    expect(retained).toBe(0)
    first.client.close()
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true)

    const replacement = await second.open(2)
    second.sent.length = 0
    second.client.handleBinary(frame(Opcode.Data, new Uint8Array([8]), 2))
    second.client.handleBinary(frame(Opcode.Close, undefined, 2))
    expect(replacement.destroyed).toBe(false)
    replacement.callbacks.requestRead()
    expect(replacement.received).toEqual([new Uint8Array([8]), null])
    replacement.callbacks.consumeReadBytes(1)
    replacement.drainEnd()
    expect(replacement.destroyed).toBe(true)
    expect(retained).toBe(0)
    expect(second.sent).toEqual([])
  })

  it('ignores stale generations and retired IDs but fences malformed frames', async () => {
    const { client, open } = createClient()
    const socket = await open()
    client.handleBinary(frame(Opcode.Error, new Uint8Array([1]), 1, 6))
    expect(socket.destroyed).toBe(false)
    socket.destroy()
    const next = await open(2)
    client.handleBinary(frame(Opcode.Data, new Uint8Array([1]), 1))
    expect(next.destroyed).toBe(false)
    client.handleBinary(new Uint8Array([1, 2, 3]))
    expect(next.destroyed).toBe(true)
    await expect(client.open({ host: 'remote.internal', port: 443 })).rejects.toThrow('closed')
  })

  it('rejects pending opens on cancellation and clears their timeout', async () => {
    vi.useFakeTimers()
    const { client, sent } = createClient()
    const opening = client.open({ host: 'pending.internal', port: 443 })
    client.close(new Error('route cancelled'))
    await expect(opening).rejects.toThrow('route cancelled')
    expect(vi.getTimerCount()).toBe(0)
    expect(sent.map(decodeBrowserNetworkTunnelFrame).map((f) => f?.opcode)).toEqual([Opcode.Open])
  })
})
