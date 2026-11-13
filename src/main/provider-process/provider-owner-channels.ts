import { createServer, type Server, type Socket } from 'node:net'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

type ChannelRole = 'duplex' | 'stderr' | 'control'
export type ProviderOwnerChannels = Record<ChannelRole, Socket>

/** One private rendezvous; headers end before raw output and never enter provider streams. */
export class ProviderOwnerListener {
  readonly nonce = randomBytes(32).toString('hex')
  private directory: string | null = null
  private server: Server | null = null
  private readonly pending = new Set<Socket>()
  private readonly channels = new Map<ChannelRole, { socket: Socket; pid: number }>()
  private expectedPid: number | null = null
  private stopped = false
  private resolveReady!: (channels: ProviderOwnerChannels) => void
  private rejectReady!: (error: Error) => void
  readonly ready = new Promise<ProviderOwnerChannels>((resolve, reject) => {
    this.resolveReady = resolve
    this.rejectReady = reject
  })

  constructor() {
    // Cancellation can precede the launch task awaiting the rendezvous.
    void this.ready.catch(() => {})
  }

  async listen(): Promise<string> {
    // Darwin's Unix socket path limit is104 bytes; its per-user TMPDIR can already exceed it.
    this.directory = await mkdtemp(
      join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'orca-provider-')
    )
    await chmod(this.directory, 0o700)
    if (this.stopped) {
      await this.close()
      throw new Error('Provider launch canceled')
    }
    const path = join(this.directory, 'owner.sock')
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket))
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(path, resolve)
    })
    await chmod(path, 0o600)
    return path
  }

  bindPid(pid: number): void {
    this.expectedPid = pid
    this.settleReady()
  }

  get outputChannels(): Pick<ProviderOwnerChannels, 'duplex' | 'stderr'> | null {
    const duplex = this.channels.get('duplex')
    const stderr = this.channels.get('stderr')
    return duplex?.pid === this.expectedPid && stderr?.pid === this.expectedPid
      ? { duplex: duplex.socket, stderr: stderr.socket }
      : null
  }

  async close(): Promise<void> {
    this.stopped = true
    this.rejectReady(new Error('Provider owner connection closed'))
    for (const socket of this.pending) {
      socket.destroy()
    }
    for (const { socket } of this.channels.values()) {
      socket.destroy()
    }
    this.pending.clear()
    this.channels.clear()
    this.server?.close()
    this.server = null
    const directory = this.directory
    this.directory = null
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  }

  private accept(socket: Socket): void {
    if (this.stopped || this.pending.size + this.channels.size >= 3) {
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
      if (length > 512) {
        return void socket.destroy()
      }
      header = Buffer.concat([header, newline === -1 ? chunk : chunk.subarray(0, newline)], length)
      if (newline === -1) {
        return
      }
      socket.pause()
      socket.off('data', read)
      try {
        const value = JSON.parse(header.toString('utf8'))
        const role: ChannelRole = value.role
        if (
          value.nonce !== this.nonce ||
          !['duplex', 'stderr', 'control'].includes(role) ||
          !Number.isSafeInteger(value.pid) ||
          value.pid <= 1 ||
          this.channels.has(role) ||
          chunk.length !== newline + 1
        ) {
          return void socket.destroy()
        }
        this.pending.delete(socket)
        this.channels.set(role, { socket, pid: value.pid })
        this.settleReady()
      } catch {
        socket.destroy()
      }
    }
    socket.on('data', read)
  }

  private settleReady(): void {
    if (!this.expectedPid || this.channels.size !== 3) {
      return
    }
    if (
      [...this.channels.values()].some(
        ({ pid, socket }) => pid !== this.expectedPid || socket.destroyed
      )
    ) {
      this.rejectReady(new Error('Provider supervisor identity did not match'))
      return
    }
    this.server?.close()
    this.resolveReady({
      duplex: this.channels.get('duplex')!.socket,
      stderr: this.channels.get('stderr')!.socket,
      control: this.channels.get('control')!.socket
    })
  }
}

export function watchProviderControl(
  control: Socket,
  handlers: { onEnd(): void; onGroup(pgid: number): void; onClose(): void }
): void {
  let metadata = ''
  control.on('data', (chunk: Buffer) => {
    metadata += chunk.toString('utf8')
    if (metadata.length > 512) {
      return void control.destroy()
    }
    let newline: number
    while ((newline = metadata.indexOf('\n')) >= 0) {
      const line = metadata.slice(0, newline)
      metadata = metadata.slice(newline + 1)
      try {
        const value = JSON.parse(line)
        if (value.reportEnd === true) {
          handlers.onEnd()
        } else if (Number.isSafeInteger(value.pgid) && value.pgid > 1) {
          handlers.onGroup(value.pgid)
        } else {
          control.destroy()
        }
      } catch {
        control.destroy()
      }
    }
  })
  control.once('close', handlers.onClose)
}
