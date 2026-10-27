import type { ConnectorFailure } from './connector-cloud-request'

const RETRY_BASE_MS = 1_000
const RETRY_MAX_MS = 30_000

/** Random doubling from 1 s to 30 s; a cloud's Retry-After wins when longer. */
export function connectorRetryDelayMs(
  failures: number,
  failure: ConnectorFailure,
  random: () => number
): number {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** failures)
  return Math.max(failure.retryAfterMs ?? 0, ceiling * (0.5 + random() / 2))
}

/** The head as last numbered: `size` items sent as `seq` under `helloRev`; 0 once taken. */
export type ConnectorStamp = {
  readonly helloRev: number
  readonly seq: number
  readonly size: number
}

export type ConnectorOutboxHead<T> = { stamp: ConnectorStamp; batch: T[] }

/**
 * Items owed to the cloud, in order. One leaves only through `accepted` with the stamp it went out under, so
 * no send, failure or hello change can lose it.
 */
export class ConnectorOutbox<T> {
  private items: T[]
  private stamp: ConnectorStamp | null = null

  constructor(
    private readonly options: {
      /** How many of the first items one request carries; at least one. */
      headSize: (items: readonly T[]) => number
      initial?: T[]
      /** Trims what is owed, never the first `sent` items, so everything owed stays within bounds. */
      bound?: (items: T[], sent: number) => T[]
      /** Called after every change with everything still owed, e.g. to persist it. */
      onChange?: (items: readonly T[]) => void
      onAccepted?: (batch: readonly T[]) => void
    }
  ) {
    this.items = options.initial ?? []
  }

  push(...items: T[]): void {
    this.replace([...this.items, ...items])
  }

  /** Numbering starts again from 0 with `first` in front, keeping what `keep` accepts. */
  restart(first: T[], keep: (item: T) => boolean): void {
    this.stamp = null
    this.replace([...first, ...this.items.filter(keep)])
  }

  /**
   * What to send under `helloRev`. The cloud skips a number it has seen, so an untaken head goes again with
   * the same number and items; only a taken one, or a new hello, numbers the next.
   */
  next(helloRev: number): ConnectorOutboxHead<T> | null {
    let stamp = this.stamp
    if (stamp?.helloRev !== helloRev || stamp.size === 0) {
      if (this.items.length === 0) {
        return null
      }
      stamp = this.stamp = {
        helloRev,
        seq: stamp?.helloRev === helloRev ? stamp.seq + 1 : 0,
        size: Math.max(1, Math.min(this.options.headSize(this.items), this.items.length))
      }
    }
    return { stamp, batch: this.items.slice(0, stamp.size) }
  }

  /** The cloud took `stamp`'s head under the hello still current; a superseded stamp changes nothing. */
  accepted(stamp: ConnectorStamp): void {
    if (this.stamp !== stamp) {
      return
    }
    const batch = this.items.splice(0, stamp.size)
    this.stamp = { ...stamp, size: 0 }
    this.notify()
    this.options.onAccepted?.(batch)
  }

  /**
   * The cloud refused `stamp`'s head as too large or malformed, which no retry fixes: it goes again as its
   * first half, same number. A single item is dropped instead; returns it so the caller can say so.
   */
  refused(stamp: ConnectorStamp): T | null {
    if (this.stamp !== stamp) {
      return null
    }
    if (stamp.size > 1) {
      this.stamp = { ...stamp, size: Math.ceil(stamp.size / 2) }
      return null
    }
    const [dropped] = this.items.splice(0, 1)
    this.stamp = { ...stamp, size: 0 }
    this.notify()
    return dropped ?? null
  }

  private replace(items: T[]): void {
    this.items = this.options.bound ? this.options.bound(items, this.stamp?.size ?? 0) : items
    this.notify()
  }

  private notify(): void {
    this.options.onChange?.(this.items)
  }
}

// Too large, or not the contract: the same request can never succeed.
const isRefusedAsSent = (failure: ConnectorFailure): boolean =>
  failure.status === 413 || failure.status === 400

/** Sends a head; null when the cloud answered 204. */
export type ConnectorBatchSender<T> = (
  batch: T[],
  helloRev: number,
  seq: number
) => Promise<ConnectorFailure | null>

/**
 * Drains an outbox one request at a time under the accepted hello, and does nothing without one. An answer
 * counts only if that hello is still accepted when it lands, so a retired or superseded one consumes nothing.
 */
export class ConnectorOutboxSender<T> {
  private sending = false
  private warned = false
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly outbox: Pick<ConnectorOutbox<T>, 'next' | 'accepted' | 'refused'>,
    private readonly send: ConnectorBatchSender<T>,
    private readonly helloRev: () => number | null,
    private readonly random: () => number
  ) {}

  /** Sends what is owed, unless a backoff is pending. */
  flush(): void {
    if (!this.retry) {
      void this.drain()
    }
  }

  /** A new hello: send now, whatever the last one's backoff. */
  resume(): void {
    this.failures = 0
    this.stop()
    void this.drain()
  }

  stop(): void {
    if (this.retry) {
      clearTimeout(this.retry)
      this.retry = null
    }
  }

  private async drain(): Promise<void> {
    if (this.sending) {
      return
    }
    this.sending = true
    try {
      for (let helloRev = this.helloRev(); helloRev !== null; helloRev = this.helloRev()) {
        const head = this.outbox.next(helloRev)
        if (!head) {
          return
        }
        const failure = await this.send(head.batch, helloRev, head.stamp.seq)
        if (this.helloRev() !== helloRev) {
          continue
        }
        if (failure && isRefusedAsSent(failure)) {
          this.dropped(this.outbox.refused(head.stamp))
          continue
        }
        if (failure) {
          this.scheduleRetry(failure)
          return
        }
        this.failures = 0
        this.outbox.accepted(head.stamp)
      }
    } finally {
      this.sending = false
    }
  }

  private dropped(item: T | null): void {
    if (item !== null && !this.warned) {
      this.warned = true
      console.warn('[connector] Orca Cloud refused an item that cannot be sent; dropped it')
    }
  }

  private scheduleRetry(failure: ConnectorFailure): void {
    this.retry = setTimeout(
      () => {
        this.retry = null
        void this.drain()
      },
      connectorRetryDelayMs(this.failures++, failure, this.random)
    )
    this.retry.unref?.()
  }
}
