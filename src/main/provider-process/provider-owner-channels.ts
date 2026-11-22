import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { HOSTED_PROVIDER_PIPE_FDS } from '../daemon/protocol/daemon-provider-process-protocol'

export type ProviderOwnerPipes = ReadonlyMap<number, Socket>

/** One private rendezvous where the host connects the native owner's pipes back to this app. */
export class ProviderOwnerListener {
  readonly nonce = randomBytes(32).toString('hex')
  private directory: string | null = null
  private server: Server | null = null
  private readonly pending = new Set<Socket>()
  private readonly pipes = new Map<number, Socket>()
  private stopped = false
  private readonly accepted = Promise.withResolvers<ProviderOwnerPipes>()
  readonly ready = this.accepted.promise

  constructor() {
    // Cancellation can precede the launch task awaiting the rendezvous.
    void this.ready.catch(() => {})
  }

  async listen(): Promise<string> {
    // Darwin's Unix socket path limit is 104 bytes; its per-user TMPDIR can already exceed it.
    this.directory = await mkdtemp(
      join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-provider-')
    )
    await chmod(this.directory, 0o700)
    if (this.stopped) {
      await this.close()
      throw new Error('Provider launch canceled')
    }
    const path = join(this.directory, 'owner.sock')
    // Pipes keep independent directions, as on a direct launch's socketpairs.
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(path, resolve)
    })
    await chmod(path, 0o600)
    return path
  }

  /** Stops accepting; pipes already handed out stay with their new owner. */
  async close(): Promise<void> {
    this.stopped = true
    this.accepted.reject(new Error('Provider owner connection closed'))
    for (const socket of [...this.pending, ...this.pipes.values()]) {
      socket.destroy()
    }
    this.pending.clear()
    this.pipes.clear()
    await this.release()
  }

  private async release(): Promise<void> {
    this.server?.close()
    this.server = null
    const directory = this.directory
    this.directory = null
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private accept(socket: Socket): void {
    if (this.stopped || this.pending.size + this.pipes.size >= HOSTED_PROVIDER_PIPE_FDS.length) {
      socket.destroy()
      return
    }
    this.pending.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => this.pending.delete(socket))
    let header = Buffer.alloc(0)
    const read = (chunk: Buffer): void => {
      const newline = chunk.indexOf(10)
      const length = header.length + (newline === -1 ? chunk.length : newline)
      if (length > 128) {
        return void socket.destroy()
      }
      header = Buffer.concat([header, newline === -1 ? chunk : chunk.subarray(0, newline)], length)
      if (newline === -1) {
        return
      }
      socket.pause()
      socket.off('data', read)
      // The native owner may already have written after the header; it belongs to that pipe.
      if (newline + 1 < chunk.length) {
        socket.unshift(chunk.subarray(newline + 1))
      }
      const [nonce = '', fdText = ''] = header.toString('utf8').split(' ')
      const fd = Number(fdText)
      if (
        !this.matchesNonce(nonce) ||
        !HOSTED_PROVIDER_PIPE_FDS.some((expected) => expected === fd) ||
        this.pipes.has(fd)
      ) {
        return void socket.destroy()
      }
      this.pending.delete(socket)
      this.pipes.set(fd, socket)
      if (this.pipes.size === HOSTED_PROVIDER_PIPE_FDS.length) {
        this.accepted.resolve(new Map(this.pipes))
        this.pipes.clear()
        void this.release()
      }
    }
    socket.on('data', read)
  }

  private matchesNonce(value: string): boolean {
    const expected = Buffer.from(this.nonce)
    const actual = Buffer.from(value)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
}
