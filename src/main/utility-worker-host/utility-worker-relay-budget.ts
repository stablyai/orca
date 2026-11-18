import { performance } from 'node:perf_hooks'

/** A reply main can't make room for within this long fails its worker instead of growing main. */
export const UTILITY_WORKER_RELAY_HOLD_LIMIT_MS = 60_000
/** Names the failure of a held reply, which says nothing about whether the worker could load. */
export const UTILITY_WORKER_RELAY_EXPIRED = 'UtilityWorkerRelayExpired'

type Held = {
  id: number
  since: number
  bytes: Uint8Array
  /** The worker's error or exit, sent right after this reply so main sees them in order. */
  followers: (() => void)[]
}

/**
 * Holds serialized worker replies in the utility process, outside main's heap, while main has more
 * than the budget delivered but not yet consumed. A reply over the whole budget goes alone. A
 * worker's first message (a reader's ready) never waits, so startup can't hang on another
 * worker's unconsumed replies.
 */
export class UtilityWorkerRelayBudget {
  private limit = Infinity
  private outstanding = 0
  private nextSeq = 0
  private readonly charged = new Map<number, { id: number; bytes: number }>()
  private readonly held: Held[] = []
  private readonly started = new Set<number>()
  /** Workers whose held reply expired: anything they post after the failure is dropped. */
  private readonly failed = new Set<number>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly relay: (id: number, bytes: Uint8Array, seq?: number) => void,
    private readonly expire: (id: number) => void,
    private readonly now = () => performance.now()
  ) {}

  setLimit(bytes: number): void {
    this.limit = bytes
  }

  offer(id: number, bytes: Uint8Array): void {
    if (this.failed.has(id)) {
      return
    }
    if (this.limit === Infinity) {
      this.relay(id, bytes)
      return
    }
    if (!this.started.has(id)) {
      this.started.add(id)
      this.send(id, bytes)
      return
    }
    this.held.push({ id, bytes, since: this.now(), followers: [] })
    this.pump()
  }

  /** Sends after the worker's own held replies, never behind another worker's; never charged. */
  after(id: number, send: () => void): void {
    const last = this.held.findLast((entry) => entry.id === id)
    if (last) {
      last.followers.push(send)
    } else {
      send()
    }
  }

  /** The worker's exit was sent; nothing more comes from it. */
  forget(id: number): void {
    this.started.delete(id)
    this.failed.delete(id)
  }

  /** No one can read this worker's replies any more: its held and unacked ones stop counting. */
  release(id: number): void {
    this.failed.add(id)
    for (const [seq, charge] of this.charged) {
      if (charge.id === id) {
        this.charged.delete(seq)
        this.outstanding -= charge.bytes
      }
    }
    this.dropHeld(id)
    this.pump()
  }

  /** Main consumed a delivered reply; a repeated or unknown ack changes nothing. */
  ack(seq: number): void {
    const charge = this.charged.get(seq)
    if (!charge) {
      return
    }
    this.charged.delete(seq)
    this.outstanding -= charge.bytes
    this.pump()
  }

  private send(id: number, bytes: Uint8Array): void {
    const seq = ++this.nextSeq
    this.charged.set(seq, { id, bytes: bytes.byteLength })
    this.outstanding += bytes.byteLength
    this.relay(id, bytes, seq)
  }

  /** A failed worker's held replies go with it; delivered ones stay charged until main acks. */
  private drop(id: number): void {
    this.failed.add(id)
    this.dropHeld(id)
    this.pump()
  }

  /** The worker's queued error or exit still runs, in order, after its replies are dropped. */
  private dropHeld(id: number): void {
    const dropped = this.held.filter((entry) => entry.id === id)
    this.held.splice(0, this.held.length, ...this.held.filter((entry) => entry.id !== id))
    for (const entry of dropped) {
      for (const send of entry.followers) {
        send()
      }
    }
  }

  private pump(): void {
    while (this.held.length > 0) {
      const next = this.held[0]!
      if (this.outstanding > 0 && this.outstanding + next.bytes.byteLength > this.limit) {
        break
      }
      this.held.shift()
      this.send(next.id, next.bytes)
      for (const send of next.followers) {
        send()
      }
    }
    this.armExpiry()
  }

  private armExpiry(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    const head = this.held[0]
    if (!head) {
      return
    }
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        const oldest = this.held[0]
        if (oldest && this.now() - oldest.since >= UTILITY_WORKER_RELAY_HOLD_LIMIT_MS) {
          // The error goes first: dropping sends whatever the worker queued behind its replies.
          this.expire(oldest.id)
          this.drop(oldest.id)
        } else {
          this.armExpiry()
        }
      },
      Math.max(0, head.since + UTILITY_WORKER_RELAY_HOLD_LIMIT_MS - this.now())
    )
  }
}
