import type { CodexAppServerConnection } from '../codex-app-server-connection-types'

/** Frames all paused chats on one server may hold in Orca before the server itself waits. */
export const CODEX_SHARED_SERVER_BACKLOG_BYTES = 32 * 1024 * 1024
/** How long a waiting chat gives the chats holding the backlog to make progress before they're
 *  dropped; well inside a Stop's 5 s interrupt timeout. */
export const CODEX_SHARED_SERVER_SHED_GRACE_MS = 1_500
/** However steady its progress, a backlog holds a waiting chat no longer than this: inside a
 *  Stop's 5 s interrupt timeout, so a co-tenant's Stop is never failed by it. */
const MAX_SHED_GRACE_MS = 4_500

type BacklogLease = {
  /** Owed a reply or a running turn's frames, or cleaning up: a paused reader would stall it. */
  readonly waiting: boolean
  /** Drops this chat's queue and ends it alone; it reconnects on its next send. */
  shed: () => void
}

/** Bytes queued by the paused chats on one server, bounded however many chats stall. Past the
 *  budget the shared reader pauses, so Codex waits as it would on a dedicated chat's pipe. With
 *  every chat paused (a journal stall) that is all: nothing is dropped. If a chat needs the server
 *  meanwhile, the chats holding the backlog get a short grace to catch up, then are dropped,
 *  largest first, so one laggard can't stall the rest. */
export class CodexSharedServerBacklog {
  private readonly bytes = new Map<BacklogLease, number>()
  /** Chats that said they wait, including ones cleaning up after they left the server's set. */
  private readonly waiters = new Set<BacklogLease>()
  private total = 0
  private paused = false
  private shedding = false
  private grace: ReturnType<typeof setTimeout> | undefined
  private graceFrom = 0
  /** When the current wait began; null while nobody waits on the backlog. */
  private graceSince: number | null = null

  constructor(
    private readonly reader: () => Pick<
      CodexAppServerConnection,
      'pauseReading' | 'resumeReading'
    > | null,
    private readonly leases: Iterable<BacklogLease>
  ) {}

  /** A chat's queue grew or shrank, or it may have started waiting (delta 0). */
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
    if (lease.waiting) {
      this.waiters.add(lease)
    } else {
      this.waiters.delete(lease)
    }
    if (!this.shedding) {
      this.settle(false)
    }
  }

  dispose(): void {
    clearTimeout(this.grace)
    this.grace = undefined
    this.graceSince = null
    this.bytes.clear()
    this.waiters.clear()
    this.total = 0
    this.paused = false
  }

  private settle(graceOver: boolean): void {
    const half = CODEX_SHARED_SERVER_BACKLOG_BYTES / 2
    if (this.total > (this.paused ? half : CODEX_SHARED_SERVER_BACKLOG_BYTES)) {
      this.setPaused(true)
      if ([...this.leases, ...this.waiters].some((lease) => lease.waiting)) {
        // A grace that saw the backlog shrink starts over, up to a cap: catching up isn't stalling.
        const now = Date.now()
        this.graceSince ??= now
        const left = MAX_SHED_GRACE_MS - (now - this.graceSince)
        if (graceOver && (this.total >= this.graceFrom || left <= 0)) {
          this.shedUntil(half)
        } else if (!this.grace) {
          this.graceFrom = this.total
          this.grace = setTimeout(
            () => {
              this.grace = undefined
              this.settle(true)
            },
            Math.max(0, Math.min(CODEX_SHARED_SERVER_SHED_GRACE_MS, left))
          )
        }
      } else {
        // Nobody waits any more; a later waiter starts its own grace.
        this.graceSince = null
      }
    }
    if (this.total <= half) {
      clearTimeout(this.grace)
      this.grace = undefined
      this.graceSince = null
      this.setPaused(false)
    }
  }

  private setPaused(paused: boolean): void {
    if (this.paused !== paused) {
      this.paused = paused
      const reader = this.reader()
      if (paused) {
        reader?.pauseReading?.()
      } else {
        reader?.resumeReading?.()
      }
    }
  }

  private shedUntil(target: number): void {
    this.shedding = true
    try {
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
        // shed() reports its dropped bytes through change(); one that reports nothing is dropped here.
        largest.shed()
        if (this.bytes.get(largest) === largestBytes) {
          this.bytes.delete(largest)
          this.total -= largestBytes
        }
      }
    } finally {
      this.shedding = false
    }
  }
}
