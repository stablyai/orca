import type { CodexAppServerConnection } from '../codex-app-server-connection-types'

/** Frames all paused chats on one server may hold in Orca before the server itself waits. */
export const CODEX_SHARED_SERVER_BACKLOG_BYTES = 32 * 1024 * 1024

type BacklogLease = {
  /** Reading, and owed a reply or a running turn's frames: a paused reader would stall it. */
  readonly waiting: boolean
  /** Drops this chat's queue and ends it alone; it reconnects on its next send. */
  shed: () => void
}

/** Bytes queued by the paused chats on one server, bounded however many chats stall. Past the
 *  budget, with every chat paused (a journal stall), the shared reader pauses and Codex waits as
 *  it would on a dedicated chat's pipe; nothing is dropped. With a chat waiting on the server, the
 *  chats holding the backlog are dropped instead, largest first, so one laggard never stalls the
 *  rest. */
export class CodexSharedServerBacklog {
  private readonly bytes = new Map<BacklogLease, number>()
  private total = 0
  private paused = false
  private shedding = false

  constructor(
    private readonly reader: () => Pick<
      CodexAppServerConnection,
      'pauseReading' | 'resumeReading'
    > | null,
    private readonly leases: Iterable<BacklogLease>
  ) {}

  /** A chat's queue grew or shrank, or it started or stopped waiting (delta 0). */
  change(lease: BacklogLease, deltaBytes: number): void {
    if (deltaBytes !== 0) {
      const held = (this.bytes.get(lease) ?? 0) + deltaBytes
      if (held > 0) {
        this.bytes.set(lease, held)
      } else {
        this.bytes.delete(lease)
      }
      this.total += deltaBytes
    }
    if (this.shedding) {
      return
    }
    const limit = this.paused
      ? CODEX_SHARED_SERVER_BACKLOG_BYTES / 2
      : CODEX_SHARED_SERVER_BACKLOG_BYTES
    if (this.total > limit && [...this.leases].some((other) => other.waiting)) {
      this.shedUntil(CODEX_SHARED_SERVER_BACKLOG_BYTES / 2)
    }
    if (!this.paused && this.total > CODEX_SHARED_SERVER_BACKLOG_BYTES) {
      this.paused = true
      this.reader()?.pauseReading?.()
    } else if (this.paused && this.total <= CODEX_SHARED_SERVER_BACKLOG_BYTES / 2) {
      this.paused = false
      this.reader()?.resumeReading?.()
    }
  }

  dispose(): void {
    this.bytes.clear()
    this.total = 0
    this.paused = false
  }

  private shedUntil(target: number): void {
    this.shedding = true
    try {
      this.shedLargestUntil(target)
    } finally {
      this.shedding = false
    }
  }

  private shedLargestUntil(target: number): void {
    while (this.total > target) {
      let largest: BacklogLease | undefined
      let largestBytes = 0
      for (const [lease, held] of this.bytes) {
        if (held > largestBytes) {
          largest = lease
          largestBytes = held
        }
      }
      if (!largest) {
        return
      }
      // shed() reports its dropped bytes through change(); a chat that already ended is dropped here.
      largest.shed()
      if (this.bytes.get(largest) === largestBytes) {
        this.bytes.delete(largest)
        this.total -= largestBytes
      }
    }
  }
}
