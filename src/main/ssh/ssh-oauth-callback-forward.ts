import { createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { LoopbackCallback } from './remote-open-url-requests'

/**
 * Opens one stream to the callback listener on the remote host, only once the real callback has
 * arrived, so nothing on this desktop can reach that listener except the matched request.
 */
export type OpenCallbackStream = (
  sshTargetId: string,
  remoteHost: string,
  remotePort: number
) => Promise<Duplex>

export type CallbackForwardResult =
  | { ok: true; port: number; lifetimeMs: number }
  | { ok: false; reason: 'port_in_use' | 'unavailable' }

type ForwarderOptions = {
  /** Whether a stream to this host could be opened now; checked up front so a dead host fails closed. */
  canReach: (sshTargetId: string) => boolean
  openStream: OpenCallbackStream
  lifetimeMs?: number
  idleMs?: number
  maxStrays?: number
}

const REQUEST_LINE_LIMIT = 8192
const REQUEST_LINE = /^[A-Z]+ (\S+) HTTP\/1\.[01]$/

/**
 * Carries one OAuth redirect from this desktop's browser back to a CLI waiting on the remote
 * host's loopback. One-shot: it passes only the first request for the callback path, then stops
 * listening; it is never saved or listed with the user's port forwards, and dies after its lifetime.
 */
export class OauthCallbackForwarder {
  private readonly active = new Map<string, () => void>()
  private readonly canReach: (sshTargetId: string) => boolean
  private readonly openStream: OpenCallbackStream
  private readonly lifetimeMs: number
  private readonly idleMs: number
  private readonly maxStrays: number

  constructor(options: ForwarderOptions) {
    this.canReach = options.canReach
    this.openStream = options.openStream
    this.lifetimeMs = options.lifetimeMs ?? 5 * 60_000
    this.idleMs = options.idleMs ?? 15_000
    this.maxStrays = options.maxStrays ?? 20
  }

  async start(sshTargetId: string, callback: LoopbackCallback): Promise<CallbackForwardResult> {
    // Why: at most one live callback per host; a newer sign-in replaces an abandoned one.
    this.active.get(sshTargetId)?.()

    if (!this.canReach(sshTargetId)) {
      return { ok: false, reason: 'unavailable' }
    }
    const server = createServer()
    const listened = await new Promise<'ok' | 'port_in_use' | 'unavailable'>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) =>
        resolve(err.code === 'EADDRINUSE' ? 'port_in_use' : 'unavailable')
      )
      server.listen(callback.port, '127.0.0.1', () => resolve('ok'))
    })
    if (listened !== 'ok') {
      // Why no alternate port: the redirect names this exact port, so any other one cannot work.
      server.close()
      return { ok: false, reason: listened }
    }

    const sockets = new Set<Socket>()
    let finished = false
    let strays = 0
    const finish = (): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(lifetime)
      server.close()
      for (const socket of sockets) {
        socket.destroy()
      }
      if (this.active.get(sshTargetId) === finish) {
        this.active.delete(sshTargetId)
      }
    }
    const lifetime = setTimeout(finish, this.lifetimeMs)
    lifetime.unref?.()
    this.active.set(sshTargetId, finish)

    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => socket.destroy())
      // Why: browsers open speculative sockets that never send; they must not hold the port.
      socket.setTimeout(this.idleMs, () => socket.destroy())
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer): void => {
        head = Buffer.concat([head, chunk])
        const lineEnd = head.indexOf('\r\n')
        if (lineEnd === -1 && head.length < REQUEST_LINE_LIMIT) {
          return
        }
        socket.off('data', onData)
        socket.pause()
        const line = lineEnd === -1 ? '' : head.subarray(0, lineEnd).toString('latin1')
        const target = REQUEST_LINE.exec(line)?.[1]
        if (!finished && target?.split('?')[0] === callback.path) {
          // Why stop listening first: one redirect per sign-in, so nothing else may follow it in.
          server.close()
          clearTimeout(lifetime)
          this.relay(socket, head, { sshTargetId, callback }, finish)
          return
        }
        socket.destroy()
        strays += 1
        if (strays >= this.maxStrays) {
          finish()
        }
      }
      socket.on('data', onData)
    })

    return { ok: true, port: callback.port, lifetimeMs: this.lifetimeMs }
  }

  /** The host went away (disconnect or removal): its pending sign-in can no longer return. */
  stopForTarget(sshTargetId: string): void {
    this.active.get(sshTargetId)?.()
  }

  stopAll(): void {
    for (const stop of this.active.values()) {
      stop()
    }
  }

  private relay(
    socket: Socket,
    head: Buffer,
    target: { sshTargetId: string; callback: LoopbackCallback },
    finish: () => void
  ): void {
    socket.setTimeout(this.idleMs, () => socket.destroy())
    socket.on('close', finish)
    this.openStream(target.sshTargetId, target.callback.host, target.callback.port).then(
      (upstream) => {
        if (socket.destroyed) {
          upstream.destroy()
          return
        }
        upstream.on('error', () => socket.destroy())
        upstream.on('close', () => socket.destroy())
        socket.on('close', () => upstream.destroy())
        upstream.write(head)
        socket.pipe(upstream).pipe(socket)
        socket.resume()
      },
      () => socket.destroy()
    )
  }
}

export function listenOnFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe: Server = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}
