import { Duplex } from 'node:stream'
import {
  BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS,
  type BrowserNetworkTunnelSocket
} from './browser-network-tunnel-stream-state'

/**
 * Adapts an execution route's socket into the `Duplex` the local SOCKS server
 * pipes to. Resolves only once the underlying transport reports `connect`, so
 * the SOCKS success reply is never sent for a dial that already failed.
 */
export function openExecutionRouteSocketAsDuplex(
  socket: BrowserNetworkTunnelSocket,
  options: { connectTimeoutMs?: number } = {}
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    let settled = false
    // Why (review P2-1): some transports flow buffered bytes on the nextTick
    // queue while emitting 'connect' from a microtask — a server banner or TLS
    // record can arrive before any consumer listener exists. Buffer from the
    // very start and replay through the duplex.
    const earlyData: Buffer[] = []
    let deliver = (bytes: Buffer): void => {
      earlyData.push(bytes)
    }
    socket.on('data', (bytes) => {
      deliver(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes))
    })
    const swapDelivery = (next: (bytes: Buffer) => void): Buffer[] => {
      deliver = next
      return earlyData
    }
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      socket.destroy()
      reject(error)
    }
    const timeout = setTimeout(
      () => fail(new Error('browser_local_route_connect_timeout')),
      options.connectTimeoutMs ?? BROWSER_NETWORK_TUNNEL_CONNECT_TIMEOUT_MS
    )
    socket.on('error', (error) => {
      if (!settled) {
        fail(error)
      }
    })
    socket.on('close', () => {
      if (!settled) {
        fail(new Error('browser_local_route_connect_closed'))
      }
    })
    socket.on('connect', () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(wrapConnectedSocket(socket, swapDelivery))
    })
  })
}

function wrapConnectedSocket(
  socket: BrowserNetworkTunnelSocket,
  swapDelivery: (next: (bytes: Buffer) => void) => Buffer[]
): Duplex {
  const duplex = new Duplex({
    read: () => {
      socket.resume()
    },
    write: (chunk: Buffer, _encoding, callback) => {
      socket.write(chunk, () => callback())
    },
    final: (callback) => {
      socket.end()
      callback()
    },
    destroy: (error, callback) => {
      socket.destroy()
      callback(error)
    }
  })
  const buffered = swapDelivery((bytes) => {
    if (!duplex.push(bytes)) {
      socket.pause()
    }
  })
  for (const bytes of buffered.splice(0)) {
    if (!duplex.push(bytes)) {
      socket.pause()
    }
  }
  socket.on('end', () => {
    duplex.push(null)
  })
  socket.on('error', (error) => {
    duplex.destroy(error)
  })
  socket.on('close', () => {
    duplex.destroy()
  })
  return duplex
}
