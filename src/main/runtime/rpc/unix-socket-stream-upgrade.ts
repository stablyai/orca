import type { Socket } from 'node:net'
import { z } from 'zod'
import { RUNTIME_LOCAL_STREAM_UPGRADE_METHOD } from '../../../shared/runtime-local-stream-protocol'
import { UnixSocketStreamConnection } from './unix-socket-stream-connection'

const UnixSocketStreamUpgradeRequest = z.object({
  method: z.literal(RUNTIME_LOCAL_STREAM_UPGRADE_METHOD)
})

// Why: the runtime layer owns auth, so it decides; the transport only switches framing once accepted.
export type UnixSocketStreamUpgrade = {
  accept(replyLine: string): UnixSocketStreamConnection | null
  reject(replyLine: string): void
}

export type UnixSocketStreamUpgradeHandler = (msg: string, upgrade: UnixSocketStreamUpgrade) => void

// Cheap substring test first: only a connection's first line is checked, but CLI params can be large.
export function isUnixSocketStreamUpgradeRequest(rawMessage: string): boolean {
  if (!rawMessage.includes(RUNTIME_LOCAL_STREAM_UPGRADE_METHOD)) {
    return false
  }
  try {
    return UnixSocketStreamUpgradeRequest.safeParse(JSON.parse(rawMessage)).success
  } catch {
    return false
  }
}

// Holds bytes a client pipelined behind its upgrade line until the runtime accepts or refuses it.
export class PendingUnixSocketStreamUpgrade {
  private pending: Buffer[] = []
  private pendingBytes = 0
  private settled = false
  readonly upgrade: UnixSocketStreamUpgrade

  constructor(
    private readonly socket: Socket,
    rest: Buffer,
    private readonly maxPendingBytes: number,
    onAccepted: (connection: UnixSocketStreamConnection) => void
  ) {
    this.push(Buffer.from(rest))
    this.upgrade = {
      accept: (replyLine) => {
        if (this.settled || socket.destroyed || !socket.writable) {
          return null
        }
        this.settled = true
        socket.write(`${replyLine}\n`)
        // Why: an idle subscription is normal on a stream; local peers close on exit, so no reaper is needed.
        socket.setTimeout(0)
        const connection = new UnixSocketStreamConnection(socket)
        for (const chunk of this.pending) {
          connection.feed(chunk)
        }
        this.pending = []
        onAccepted(connection)
        return connection
      },
      reject: (replyLine) => {
        if (this.settled) {
          return
        }
        this.settled = true
        this.pending = []
        if (!socket.destroyed && socket.writable) {
          socket.write(`${replyLine}\n`)
        }
        socket.end()
      }
    }
  }

  push(chunk: Buffer): void {
    if (this.settled || chunk.length === 0) {
      return
    }
    this.pending.push(chunk)
    this.pendingBytes += chunk.length
    if (this.pendingBytes > this.maxPendingBytes) {
      this.settled = true
      this.pending = []
      this.socket.destroy()
    }
  }
}
