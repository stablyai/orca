/** A reply main can't make room for within this long fails its worker instead of growing main. */
export const UTILITY_WORKER_RELAY_HOLD_LIMIT_MS = 60_000

type Held =
  | { id: number; since: number; bytes: Uint8Array }
  /** A worker's error or exit, kept behind its held replies so main sees them in order. */
  | { id: number; since: number; send: () => void }

/**
 * Holds serialized worker replies in the utility process, outside main's heap, while main has more
 * than the budget delivered but not yet consumed. A reply over the whole budget goes alone.
 */
export class UtilityWorkerRelayBudget {
  private limit = Infinity
  private outstanding = 0
  private nextSeq = 0
  private readonly charged = new Map<number, number>()
  private readonly held: Held[] = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(
    private readonly relay: (id: number, bytes: Uint8Array, seq?: number) => void,
    private readonly expire: (id: number) => void,
    private readonly now = Date.now
  ) {}

  setLimit(bytes: number): void {
    this.limit = bytes
  }

  offer(id: number, bytes: Uint8Array): void {
    if (this.limit === Infinity) {
      this.relay(id, bytes)
      return
    }
    this.held.push({ id, bytes, since: this.now() })
    this.pump()
  }

  /** Sends at once unless held replies are waiting, then after them; never charged. */
  after(id: number, send: () => void): void {
    if (this.held.length === 0) {
      send()
      return
    }
    this.held.push({ id, since: this.now(), send })
  }

  /** Main consumed a delivered reply; a repeated or unknown ack changes nothing. */
  ack(seq: number): void {
    const bytes = this.charged.get(seq)
    if (bytes === undefined) {
      return
    }
    this.charged.delete(seq)
    this.outstanding -= bytes
    this.pump()
  }

  /** A failed worker's held replies go with it; delivered ones stay charged until main acks. */
  private drop(id: number): void {
    for (let index = this.held.length - 1; index >= 0; index--) {
      const entry = this.held[index]!
      if (entry.id === id && 'bytes' in entry) {
        this.held.splice(index, 1)
      }
    }
    this.pump()
  }

  private pump(): void {
    while (this.held.length > 0) {
      const next = this.held[0]!
      if ('send' in next) {
        this.held.shift()
        next.send()
        continue
      }
      const { id, bytes } = next
      if (this.outstanding > 0 && this.outstanding + bytes.byteLength > this.limit) {
        break
      }
      this.held.shift()
      const seq = ++this.nextSeq
      this.charged.set(seq, bytes.byteLength)
      this.outstanding += bytes.byteLength
      this.relay(id, bytes, seq)
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
          this.drop(oldest.id)
          this.expire(oldest.id)
        } else {
          this.armExpiry()
        }
      },
      Math.max(0, head.since + UTILITY_WORKER_RELAY_HOLD_LIMIT_MS - this.now())
    )
  }
}
