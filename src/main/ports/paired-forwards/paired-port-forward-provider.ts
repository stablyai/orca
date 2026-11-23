import { createServer, type Socket } from 'node:net'
import { BROWSER_NETWORK_TUNNEL_MAX_STREAMS } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { reserveBrowserTunnelOrcaListenerPort } from '../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import { pipeUpstreamToClient } from '../../browser/network/tunnels/remote-browser-socks-upstream'
import { listenForPortForward } from '../../ssh/port-forwarding/ssh2-port-forward-provider'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from '../../ssh/port-forwarding/ssh-port-forward-provider'
import type { PairedPortForwardTunnel } from './paired-port-forward-tunnel'

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

    const server = createServer({ noDelay: true, pauseOnConnect: true }, (socket) => {
      activeSockets.add(socket)
      socket.on('close', () => activeSockets.delete(socket))
      socket.on('error', () => socket.destroy())
      tunnel.open(target).then(
        (upstream) => {
          if (closed || socket.destroyed) {
            upstream.destroy()
            socket.destroy()
            return
          }
          upstream.once('error', () => socket.destroy())
          upstream.once('close', () => socket.destroy())
          socket.once('close', () => upstream.destroy())
          socket.pipe(upstream)
          pipeUpstreamToClient(upstream, socket)
          socket.resume()
        },
        () => socket.destroy()
      )
    })
    server.maxConnections = BROWSER_NETWORK_TUNNEL_MAX_STREAMS

    await listenForPortForward(server, options.localHost, options.localPort)
    const address = server.address()
    const localPort = typeof address === 'object' && address ? address.port : options.localPort
    // This desktop's own paired clients must not reach the server's ports through this listener.
    const releaseReservation = reserveBrowserTunnelOrcaListenerPort(localPort)

    const close = (): Promise<void> => {
      if (closed) {
        return Promise.resolve()
      }
      closed = true
      releaseReservation()
      for (const socket of activeSockets) {
        socket.destroy()
      }
      return new Promise((resolve) => {
        server.close(() => resolve())
      })
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
