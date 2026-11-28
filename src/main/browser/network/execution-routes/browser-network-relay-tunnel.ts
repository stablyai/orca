import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import {
  BrowserNetworkTunnelStreamFrameDecoder,
  BrowserNetworkTunnelStreamFrameWriter
} from '../../../../shared/browser/network/tunnels/browser-network-tunnel-stream-framing'
import { BrowserNetworkTunnelClient } from '../tunnels/browser-network-tunnel-client'
import type { BrowserNetworkTunnelDuplex } from '../tunnels/browser-network-tunnel-duplex'
import {
  BROWSER_NETWORK_RELAY_FLOW_CONTROL,
  BROWSER_NETWORK_RELAY_WRITER_LIMITS
} from '../tunnels/browser-network-tunnel-stream-state'
import { BrowserNetworkDeferredSocket } from './browser-network-deferred-socket'
import type { BrowserNetworkRelayChild } from './browser-network-relay-launch'

export type BrowserNetworkRelayTunnel = {
  open(target: BrowserNetworkTunnelOpen): Promise<BrowserNetworkTunnelDuplex>
  /** A deferred socket for `open`, failing loudly once the relay is gone. */
  connect(target: BrowserNetworkTunnelOpen): BrowserNetworkDeferredSocket
  /** False once the relay is gone or has used up its stream ids; callers then start a new one. */
  isValid(): boolean
  whenInvalidated: Promise<void>
  close(): void
}

/** Multiplexes destination streams over one relay's stdio; stopping either side stops the relay. */
export function attachBrowserNetworkRelayTunnel(
  child: BrowserNetworkRelayChild,
  signal?: AbortSignal
): BrowserNetworkRelayTunnel {
  let valid = true
  let resolveInvalidated = (): void => {}
  const whenInvalidated = new Promise<void>((resolve) => {
    resolveInvalidated = resolve
  })
  let client: BrowserNetworkTunnelClient
  const writer = new BrowserNetworkTunnelStreamFrameWriter(
    (bytes, callback) => child.stdin.write(bytes, callback),
    (error) => invalidate(error),
    BROWSER_NETWORK_RELAY_WRITER_LIMITS
  )
  const decoder = new BrowserNetworkTunnelStreamFrameDecoder(
    (frame) => client.handleBinary(frame),
    (error) => invalidate(error)
  )
  client = new BrowserNetworkTunnelClient({
    tunnelGeneration: 1,
    flowControl: BROWSER_NETWORK_RELAY_FLOW_CONTROL,
    sendBinary: (frame) => writer.send(frame),
    onClosed: (error) => invalidate(error)
  })

  const invalidate = (error: Error, kill = true): void => {
    if (!valid) {
      return
    }
    valid = false
    signal?.removeEventListener('abort', onAbort)
    decoder.close()
    writer.close()
    client.close(error)
    if (kill) {
      child.kill()
    }
    resolveInvalidated()
  }
  const onAbort = (): void => invalidate(new Error('browser_tunnel_execution_host_unavailable'))
  signal?.addEventListener('abort', onAbort, { once: true })
  child.stdout.on('data', (bytes: Buffer) => decoder.feed(bytes))
  // Launch paused stdout at the readiness sentinel.
  child.stdout.resume()
  child.stdout.on('error', (error) => invalidate(error))
  child.stdin.on('error', (error) => invalidate(error))
  child.on('error', (error) => invalidate(error, false))
  child.on('close', () => invalidate(new Error('browser_tunnel_execution_host_unavailable'), false))
  if (signal?.aborted) {
    onAbort()
  }

  const open = (target: BrowserNetworkTunnelOpen): Promise<BrowserNetworkTunnelDuplex> =>
    valid
      ? client.open(target)
      : Promise.reject(new Error('browser_tunnel_execution_host_unavailable'))
  return {
    open,
    connect: (target) => {
      const socket = new BrowserNetworkDeferredSocket()
      void open(target).then(
        (source) => socket.attach(source),
        (error: unknown) => socket.fail(error instanceof Error ? error : new Error(String(error)))
      )
      return socket
    },
    isValid: () => valid && !client.streamIdsExhausted,
    whenInvalidated,
    close: () => invalidate(new Error('browser_tunnel_execution_host_unavailable'))
  }
}
