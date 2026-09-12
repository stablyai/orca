import { once } from 'node:events'
import { expect, it, vi } from 'vitest'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import { openExecutionRouteSocketAsDuplex } from './execution-route-socket-duplex'
import {
  BrowserNetworkTunnelOpcode as Op,
  encodeBrowserNetworkTunnelFrame
} from '../../shared/browser-network-tunnel-protocol'

it('propagates downstream write settlement through both execution-route wrappers', async () => {
  const client = new BrowserNetworkTunnelClient({ tunnelGeneration: 7, sendBinary: () => true })
  const send = (opcode: Op, payload: Uint8Array<ArrayBufferLike> = new Uint8Array()) =>
    client.handleBinary(
      encodeBrowserNetworkTunnelFrame({ opcode, payload, tunnelGeneration: 7, streamId: 1 })
    )
  const opening = client.open({ host: 'remote.internal', port: 443 })
  send(Op.Opened)
  const source = await opening
  const deferred = new BrowserNetworkDeferredSocket()
  const wrapping = openExecutionRouteSocketAsDuplex(deferred)
  deferred.attach(source)
  const wrapped = (await wrapping) as Awaited<typeof wrapping> & {
    settleRead: (bytes: number) => void
  }
  const received = vi.fn()
  wrapped.on('data', received)
  const fence = client.fenceForDrain({ drain: async () => {}, assertDrained: () => {} })
  try {
    const ended = once(wrapped, 'end')
    send(Op.Data, Buffer.from('tail'))
    send(Op.Close)
    await ended
    expect(received).toHaveBeenCalledOnce()
    expect(source.destroyed).toBe(false)
    expect(wrapped.destroyed).toBe(false)
    expect(fence.assertDrained).toThrow('not_drained')
    wrapped.settleRead(4)
    await fence.drain(new AbortController().signal)
    expect(source.destroyed).toBe(true)
  } finally {
    wrapped.destroy()
    client.close()
  }
})
