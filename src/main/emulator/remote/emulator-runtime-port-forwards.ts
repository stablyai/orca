import { createServer, type Server, type Socket } from 'node:net'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelDuplex } from '../../browser/network/tunnels/browser-network-tunnel-duplex'
import { pipeUpstreamToClient } from '../../browser/network/tunnels/remote-browser-socks-upstream'

// Idle forwards are just loopback listeners; a runtime would need this many helper ports to hit it.
const MAX_FORWARDS = 64

type Forward = {
  server: Server
  localPort: Promise<number>
  boundPort: number | null
  sockets: Set<Socket>
}

/**
 * Loopback listeners on this machine that each reach one port on a paired runtime's loopback.
 * Panes keep the URLs they were given, even while parked, so a forward is never closed under them.
 */
export class EmulatorRuntimePortForwards {
  private readonly forwards = new Map<number, Forward>()

  constructor(
    private readonly open: (target: BrowserNetworkTunnelOpen) => Promise<BrowserNetworkTunnelDuplex>
  ) {}

  localPortFor(remotePort: number): Promise<number> {
    const existing = this.forwards.get(remotePort)
    if (existing) {
      return existing.localPort
    }
    if (this.forwards.size >= MAX_FORWARDS) {
      return Promise.reject(new Error('Too many emulator stream forwards'))
    }
    const forward: Forward = {
      server: createServer({ allowHalfOpen: true }, (socket) =>
        this.accept(forward, remotePort, socket)
      ),
      localPort: Promise.resolve(0),
      boundPort: null,
      sockets: new Set()
    }
    forward.localPort = new Promise((resolve, reject) => {
      forward.server.once('error', reject)
      forward.server.listen(0, '127.0.0.1', () => {
        forward.server.off('error', reject)
        const address = forward.server.address()
        if (address && typeof address === 'object') {
          forward.boundPort = address.port
          resolve(address.port)
        } else {
          reject(new Error('Emulator stream forward has no port'))
        }
      })
    })
    this.forwards.set(remotePort, forward)
    forward.localPort.catch(() => this.closeForward(remotePort, forward))
    return forward.localPort
  }

  /** True while `localPort` still forwards to `remotePort`. */
  isLive(remotePort: number, localPort: number): boolean {
    return this.forwards.get(remotePort)?.boundPort === localPort
  }

  close(): void {
    for (const [remotePort, forward] of this.forwards) {
      this.closeForward(remotePort, forward)
    }
  }

  private accept(forward: Forward, remotePort: number, socket: Socket): void {
    forward.sockets.add(socket)
    socket.pause()
    socket.once('close', () => forward.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    this.open({ host: '127.0.0.1', port: remotePort }).then(
      (upstream) => {
        if (socket.destroyed) {
          upstream.destroy()
          return
        }
        socket.pipe(upstream)
        pipeUpstreamToClient(upstream, socket)
        upstream.once('error', () => socket.destroy())
        upstream.once('close', () => socket.destroy())
        socket.once('close', () => upstream.destroy())
        socket.resume()
      },
      () => socket.destroy()
    )
  }

  private closeForward(remotePort: number, forward: Forward): void {
    if (this.forwards.get(remotePort) !== forward) {
      return
    }
    this.forwards.delete(remotePort)
    forward.server.close()
    for (const socket of forward.sockets) {
      socket.destroy()
    }
  }
}
