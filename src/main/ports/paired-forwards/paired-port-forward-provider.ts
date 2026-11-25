import { createServer, type Server, type Socket } from 'node:net'
import { BROWSER_NETWORK_TUNNEL_MAX_STREAMS } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { reserveBrowserTunnelOrcaListenerPort } from '../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import { pipeUpstreamToClient } from '../../browser/network/tunnels/remote-browser-socks-upstream'
import {
  createSocksClientAdmission,
  holdSocksClientOwnerLookup
} from '../../browser/network/tunnels/remote-browser-socks-client-owner'
import { listenForPortForward } from '../../ssh/port-forwarding/ssh2-port-forward-provider'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

// A desktop without IPv6 loopback can't hold [::1], and nothing local can listen there either.
const IPV6_UNAVAILABLE = /EADDRNOTAVAIL|EAFNOSUPPORT|EPROTONOSUPPORT/

/** Whether a forward also listens on [::1]; only where its connections' owner can be checked there. */
export function holdsIpv6Loopback(platform: NodeJS.Platform): boolean {
  return platform !== 'win32'
}

/** A loopback listener whose connections each open one stream on the server's forward tunnel. */
export class PairedPortForwardProvider implements SshPortForwardProvider<PairedPortForwardTunnel> {
  canHandle(tunnel: PairedPortForwardTunnel): boolean {
    return !tunnel.isDisposed()
  }

  async start(
    tunnel: PairedPortForwardTunnel,
    options: PortForwardStartOptions
  ): Promise<StartedPortForward<PairedPortForwardTunnel>> {
    const activeSockets = new Set<Socket>()
    let closed = false
    const target = { host: options.remoteHost, port: options.remotePort }

    // Another OS account on this computer may not ride this desktop's pairing (uid on Linux, SID on Windows, own processes on macOS).
    const admitClient = createSocksClientAdmission('port forward')
    const forward = (socket: Socket): void => {
      tunnel.open(target).then(
        (upstream) => {
          if (closed || socket.destroyed) {
            upstream.destroy()
            socket.destroy()
            return
          }
          upstream.once('error', () => socket.destroy())
          // After a clean end the socket still flushes the response; only an abrupt close cuts it.
          upstream.once('close', () => {
            if (!socket.writableEnded) {
              socket.destroy()
            }
          })
          socket.once('close', () => upstream.destroy())
          socket.pipe(upstream)
          pipeUpstreamToClient(upstream, socket)
          socket.resume()
        },
        () => socket.destroy()
      )
    }
    const accept = (socket: Socket): void => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => socket.destroy())
      admitClient(socket, () => forward(socket))
    }
    const listen = async (host: string, port: number): Promise<Server> => {
      // Half-open keeps a response flowing after a client shuts down its request side.
      const server = createServer(
        { noDelay: true, pauseOnConnect: true, allowHalfOpen: true },
        accept
      )
      server.maxConnections = BROWSER_NETWORK_TUNNEL_MAX_STREAMS
      await listenForPortForward(server, host, port)
      return server
    }

    // Held before the first connection can arrive, so admission never finds the lookup stopped.
    const releaseOwnerLookup = holdSocksClientOwnerLookup()
    const servers = [
      await listen(options.localHost, options.localPort).catch((error: unknown) => {
        releaseOwnerLookup()
        throw error
      })
    ]
    const address = servers[0]!.address()
    const localPort = typeof address === 'object' && address ? address.port : options.localPort
    // Browsers try [::1] first for localhost, so the forward holds that address too; a later local
    // server there could otherwise answer the forwarded link. Windows' owner lookup reads IPv4
    // connections only, so there the forward stays IPv4 and creation's [::1] probe guards it.
    try {
      if (holdsIpv6Loopback(process.platform)) {
        servers.push(await listen('::1', localPort))
      }
    } catch (error) {
      if (!IPV6_UNAVAILABLE.test(error instanceof Error ? error.message : String(error))) {
        // A client may already hold the IPv4 half; close() would wait on it forever.
        closed = true
        for (const socket of activeSockets) {
          socket.destroy()
        }
        await new Promise((resolve) => servers[0]!.close(resolve))
        releaseOwnerLookup()
        throw error
      }
    }
    // This desktop's own paired clients must not reach the server's ports through this listener.
    const releaseReservation = reserveBrowserTunnelOrcaListenerPort(localPort)

    const close = (): Promise<void> => {
      if (closed) {
        return Promise.resolve()
      }
      closed = true
      releaseReservation()
      releaseOwnerLookup()
      for (const socket of activeSockets) {
        socket.destroy()
      }
      return Promise.all(
        servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      ).then(() => {})
    }

    return {
      entry: {
        id: options.id,
        connectionId: options.connectionId,
        localPort,
        remoteHost: options.remoteHost,
        remotePort: options.remotePort,
        label: options.label
      },
      close,
      dispose: () => {
        void close()
      },
      isLive: (current) => !closed && current === tunnel && !tunnel.isDisposed()
    }
  }
}
