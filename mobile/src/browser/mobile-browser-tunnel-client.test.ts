import { describe, expect, it, vi } from 'vitest'
import {
  BrowserNetworkTunnelOpcode,
  decodeBrowserNetworkTunnelFrame,
  decodeBrowserNetworkTunnelOpen,
  decodeBrowserNetworkTunnelWindowUpdate,
  encodeBrowserNetworkTunnelFrame,
  encodeBrowserNetworkTunnelWindowUpdate,
  type BrowserNetworkTunnelFrame
} from '../../../src/shared/browser-network-tunnel-protocol'
import type { MobileBrowserTunnelEvent } from '../../../src/shared/mobile-browser-tunnel-protocol'
import {
  MobileBrowserTunnelClient,
  type MobileBrowserTunnelStreamSink
} from './mobile-browser-tunnel-client'

function harness(onClosed?: () => void) {
  const sent: BrowserNetworkTunnelFrame[] = []
  let deliver: (frame: Uint8Array) => void = () => {}
  let emit: (event: MobileBrowserTunnelEvent) => void = () => {}
  const unsubscribe = vi.fn()
  const client = new MobileBrowserTunnelClient({
    channel: {
      send: (bytes) => {
        const frame = decodeBrowserNetworkTunnelFrame(bytes)
        if (frame) {
          sent.push(frame)
        }
        return true
      },
      onFrame: (listener) => {
        deliver = listener
        return () => {}
      }
    },
    subscribe: (onEvent) => {
      emit = onEvent
      return unsubscribe
    },
    onClosed
  })
  let generation = 0
  return {
    client,
    sent,
    unsubscribe,
    ready: (next: number) => {
      generation = next
      emit({ type: 'ready', tunnelGeneration: next, subscriptionId: `tunnel-${next}` })
    },
    emit: (event: MobileBrowserTunnelEvent) => emit(event),
    host: (
      opcode: BrowserNetworkTunnelOpcode,
      streamId: number,
      payload: Uint8Array = new Uint8Array()
    ) =>
      deliver(
        encodeBrowserNetworkTunnelFrame({ opcode, tunnelGeneration: generation, streamId, payload })
      ),
    sentOf: (opcode: BrowserNetworkTunnelOpcode) => sent.filter((frame) => frame.opcode === opcode)
  }
}

function sink() {
  return {
    opened: vi.fn<MobileBrowserTunnelStreamSink['opened']>(),
    data: vi.fn<MobileBrowserTunnelStreamSink['data']>(),
    end: vi.fn<MobileBrowserTunnelStreamSink['end']>(),
    closed: vi.fn<MobileBrowserTunnelStreamSink['closed']>()
  }
}

const KIB = 1024

describe('MobileBrowserTunnelClient', () => {
  it('opens a stream once the tunnel is ready and grants the host its window', () => {
    const tunnel = harness()
    const stream = sink()
    tunnel.client.open({ host: 'example.test', port: 443 }, stream)
    expect(tunnel.sent).toEqual([])

    tunnel.ready(7)
    const [open] = tunnel.sentOf(BrowserNetworkTunnelOpcode.Open)
    expect(open?.tunnelGeneration).toBe(7)
    expect(decodeBrowserNetworkTunnelOpen(open!.payload)).toEqual({
      host: 'example.test',
      port: 443
    })

    tunnel.host(BrowserNetworkTunnelOpcode.Opened, open!.streamId)
    expect(stream.opened).toHaveBeenCalledOnce()
    const [grant] = tunnel.sentOf(BrowserNetworkTunnelOpcode.WindowUpdate)
    expect(decodeBrowserNetworkTunnelWindowUpdate(grant!.payload)).toBe(256 * KIB)
  })

  it('sends page bytes only within the host credit, in 64 KiB frames', () => {
    const tunnel = harness()
    tunnel.ready(1)
    const handle = tunnel.client.open({ host: 'example.test', port: 80 }, sink())
    tunnel.host(BrowserNetworkTunnelOpcode.Opened, 1)

    handle.write(new Uint8Array(100 * KIB))
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.Data)).toEqual([])

    tunnel.host(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      1,
      encodeBrowserNetworkTunnelWindowUpdate(80 * KIB)
    )
    expect(
      tunnel.sentOf(BrowserNetworkTunnelOpcode.Data).map((frame) => frame.payload.byteLength)
    ).toEqual([64 * KIB, 16 * KIB])

    handle.end()
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.HalfClose)).toEqual([])
    tunnel.host(
      BrowserNetworkTunnelOpcode.WindowUpdate,
      1,
      encodeBrowserNetworkTunnelWindowUpdate(20 * KIB)
    )
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.Data).at(-1)?.payload.byteLength).toBe(20 * KIB)
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.HalfClose)).toHaveLength(1)
  })

  it('hands host bytes to the page and returns their credit', () => {
    const tunnel = harness()
    tunnel.ready(1)
    const stream = sink()
    tunnel.client.open({ host: 'example.test', port: 80 }, stream)
    tunnel.host(BrowserNetworkTunnelOpcode.Opened, 1)

    tunnel.host(BrowserNetworkTunnelOpcode.Data, 1, new Uint8Array([1, 2, 3]))
    expect(stream.data).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    const grants = tunnel.sentOf(BrowserNetworkTunnelOpcode.WindowUpdate)
    expect(decodeBrowserNetworkTunnelWindowUpdate(grants.at(-1)!.payload)).toBe(3)

    tunnel.host(BrowserNetworkTunnelOpcode.HalfClose, 1)
    expect(stream.end).toHaveBeenCalledOnce()
    tunnel.host(BrowserNetworkTunnelOpcode.Error, 1, new TextEncoder().encode('destination_error'))
    expect(stream.closed).toHaveBeenCalledWith('destination_error')
  })

  it('answers host pings', () => {
    const tunnel = harness()
    tunnel.ready(1)
    tunnel.host(BrowserNetworkTunnelOpcode.Ping, 0, new Uint8Array([5]))
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.Pong)).toEqual([
      expect.objectContaining({ streamId: 0, payload: new Uint8Array([5]) })
    ])
  })

  it('ends open streams when the tunnel restarts on a new socket and numbers new ones afresh', () => {
    const tunnel = harness()
    tunnel.ready(1)
    const first = sink()
    tunnel.client.open({ host: 'example.test', port: 80 }, first)

    tunnel.ready(2)
    expect(first.closed).toHaveBeenCalledWith('tunnel_restarted')
    tunnel.client.open({ host: 'example.test', port: 80 }, sink())
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.Open).at(-1)).toEqual(
      expect.objectContaining({ tunnelGeneration: 2, streamId: 1 })
    )
  })

  it('ends open streams when the host closes the tunnel', () => {
    const tunnel = harness()
    tunnel.ready(1)
    const stream = sink()
    tunnel.client.open({ host: 'example.test', port: 80 }, stream)
    tunnel.emit({ type: 'closed', tunnelGeneration: 1 })
    expect(stream.closed).toHaveBeenCalledWith('tunnel_closed')
  })

  it('closes queued and open streams and unsubscribes on close', () => {
    const tunnel = harness()
    const queued = sink()
    tunnel.client.open({ host: 'example.test', port: 80 }, queued)
    tunnel.client.close()
    expect(queued.closed).toHaveBeenCalledWith('tunnel_closed')
    expect(tunnel.unsubscribe).toHaveBeenCalledOnce()
  })
})

describe('a tunnel the host closed', () => {
  it('fails new streams at once and reports the close, until a new socket replays the subscription', () => {
    const onClosed = vi.fn()
    const tunnel = harness(onClosed)
    tunnel.ready(3)
    tunnel.emit({ type: 'closed', tunnelGeneration: 3 })
    expect(onClosed).toHaveBeenCalledOnce()
    const late = sink()
    tunnel.client.open({ host: 'example.com', port: 443 }, late)
    expect(late.closed).toHaveBeenCalledWith('tunnel_closed')

    tunnel.ready(4)
    const replayed = sink()
    tunnel.client.open({ host: 'example.com', port: 443 }, replayed)
    expect(replayed.closed).not.toHaveBeenCalled()
    expect(tunnel.sentOf(BrowserNetworkTunnelOpcode.Open)).toHaveLength(1)
  })
})
