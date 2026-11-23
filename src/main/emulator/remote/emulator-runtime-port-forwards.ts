import { createServer, type Server, type Socket } from 'node:net'
import type { BrowserNetworkTunnelOpen } from '../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { BrowserNetworkTunnelDuplex } from '../../browser/network/tunnels/browser-network-tunnel-duplex'
import { pipeUpstreamToClient } from '../../browser/network/tunnels/remote-browser-socks-upstream'

const IDLE_CLOSE_MS = 5 * 60_000
const MAX_FORWARDS = 16

type Forward = {
  server: Server
  localPort: Promise<number>
  sockets: Set<Socket>
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** Loopback listeners on this machine that each reach one port on a paired runtime's loopback. */
export class EmulatorRuntimePortForwards {
  private readonly forwards = new Map<number, Forward>()

  constructor(
    private readonly open: (
      target: BrowserNetworkTunnelOpen
    ) => Promise<BrowserNetworkTunnelDuplex>,
    private readonly onEmpty: () => void = () => {}
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
      sockets: new Set(),
      idleTimer: null
    }
    forward.localPort = new Promise((resolve, reject) => {
      forward.server.once('error', reject)
      forward.server.listen(0, '127.0.0.1', () => {
        forward.server.off('error', reject)
        const address = forward.server.address()
        if (address && typeof address === 'object') {
          resolve(address.port)
        } else {
          reject(new Error('Emulator stream forward has no port'))
        }
      })
    })
    this.forwards.set(remotePort, forward)
    forward.localPort.then(
      () => this.armIdle(remotePort, forward),
      () => this.closeForward(remotePort, forward)
    )
    return forward.localPort
  }

  close(): void {
    for (const [remotePort, forward] of this.forwards) {
      this.closeForward(remotePort, forward)
    }
  }

  private accept(forward: Forward, remotePort: number, socket: Socket): void {
    forward.sockets.add(socket)
    if (forward.idleTimer) {
      clearTimeout(forward.idleTimer)
      forward.idleTimer = null
    }
    socket.pause()
    socket.once('close', () => {
      forward.sockets.delete(socket)
      this.armIdle(remotePort, forward)
    })
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

  // Streams reconnect every second while a pane shows them, so a quiet listener has no viewer.
  private armIdle(remotePort: number, forward: Forward): void {
    if (
      forward.sockets.size > 0 ||
      forward.idleTimer ||
      this.forwards.get(remotePort) !== forward
    ) {
      return
    }
    forward.idleTimer = setTimeout(() => this.closeForward(remotePort, forward), IDLE_CLOSE_MS)
    forward.idleTimer.unref?.()
  }

  private closeForward(remotePort: number, forward: Forward): void {
    if (this.forwards.get(remotePort) !== forward) {
      return
    }
    this.forwards.delete(remotePort)
    if (forward.idleTimer) {
      clearTimeout(forward.idleTimer)
    }
    forward.server.close()
    for (const socket of forward.sockets) {
      socket.destroy()
    }
    if (this.forwards.size === 0) {
      this.onEmpty()
    }
  }
}
