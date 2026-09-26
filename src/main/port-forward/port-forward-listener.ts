import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { pipeUpstreamToClient } from '../browser/remote-browser-socks-upstream'

/** Opens one tunnel stream to the host's loopback port. One call per inbound connection. */
export type PortForwardStreamOpener = () => Promise<Duplex>

export type PortForwardBinding = {
  /** Port actually bound on this machine. */
  port: number
  /** False when the preferred port was taken and another had to be used. Callers must
   *  surface this: a remapped port breaks hot-reload sockets, OAuth redirect URIs and
   *  absolute asset paths, all of which carry the original number. */
  exact: boolean
}

const LOOPBACK_BIND_HOST = '127.0.0.1'

function listenOn(server: Server, port: number): Promise<number | 'in-use'> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening)
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        resolve('in-use')
        return
      }
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, LOOPBACK_BIND_HOST)
  })
}

/**
 * A loopback listener on this machine whose connections are carried to one port on the
 * remote host. Bound to 127.0.0.1 only — the forward exists to make a remote port
 * reachable locally, never to republish it to the network.
 */
export class PortForwardListener {
  private readonly openStream: PortForwardStreamOpener
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private closed = false

  constructor(openStream: PortForwardStreamOpener) {
    this.openStream = openStream
    this.server = createServer((socket) => this.accept(socket))
  }

  async listen(preferredPort: number): Promise<PortForwardBinding> {
    // Why the preferred port first: keeping the number identical to the host's means the
    // URL the dev server believes it is serving is the URL that works here.
    const preferred = await listenOn(this.server, preferredPort)
    if (preferred !== 'in-use') {
      return { port: preferred, exact: true }
    }
    const fallback = await listenOn(this.server, 0)
    if (fallback === 'in-use') {
      throw new Error('port_forward_listen_failed')
    }
    return { port: fallback, exact: false }
  }

  private accept(socket: Socket): void {
    if (this.closed) {
      socket.destroy()
      return
    }
    this.sockets.add(socket)
    socket.setNoDelay(true)
    socket.on('close', () => this.sockets.delete(socket))
    // Why: an inbound connection that never reaches the host must die rather than hang
    // the browser tab waiting on a socket nothing is attached to.
    socket.on('error', () => socket.destroy())
    socket.pause()

    this.openStream()
      .then((upstream) => {
        if (this.closed || socket.destroyed) {
          upstream.destroy()
          socket.destroy()
          return
        }
        upstream.on('error', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        socket.pipe(upstream)
        pipeUpstreamToClient(upstream, socket)
        socket.resume()
      })
      .catch(() => socket.destroy())
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    for (const socket of this.sockets) {
      socket.destroy()
    }
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}
