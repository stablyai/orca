import { connect, type Socket } from 'node:net'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'

// Settle on connect so an immediate dial error (emitted on nextTick) cannot outrun its listener.
export function openConnectedSocket(
  endpoint: BrowserNetworkTunnelOpen,
  signal: AbortSignal
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ ...endpoint, allowHalfOpen: true })
    const abandon = (): void => {
      socket.destroy()
      reject(new Error('browser_tunnel_proxy_connect_abandoned'))
    }
    const fail = (error: Error): void => {
      signal.removeEventListener('abort', abandon)
      reject(error)
    }
    signal.addEventListener('abort', abandon, { once: true })
    socket.on('error', fail)
    // Keep fail attached: an error between connect and the caller's listeners must not go uncaught.
    socket.once('connect', () => {
      signal.removeEventListener('abort', abandon)
      resolve(socket)
    })
  })
}
