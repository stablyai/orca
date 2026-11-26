import type { ProviderRelayExit } from '../protocol/daemon-provider-relay-protocol'

/** What stopped a relay's agent: the idle stop, or the detached cap with its work open or finished. */
export type ProviderRelayStop = 'idle' | 'cap' | 'cap-finished' | null

/** A cap stop whose work had all ended is finished, as an idle stop is; its kept output says cap. */
export function providerRelayStopFlags(
  stop: ProviderRelayStop
): Pick<ProviderRelayExit, 'idleStopped' | 'capStopped'> {
  return {
    ...(stop === 'idle' || stop === 'cap-finished' ? { idleStopped: true as const } : {}),
    ...(stop === 'cap' || stop === 'cap-finished' ? { capStopped: true as const } : {})
  }
}

/** A detached agent held only by output no app took, or by work the idle stop can't see, ends after this. */
export const RELAY_DETACHED_CAP_MS = 24 * 60 * 60 * 1000
/** A spawned agent no app attached this soon was lost with its spawn reply: nothing will claim it. */
export const RELAY_UNCLAIMED_MS = 60_000

export type CappableRelay = {
  readonly relayId: string
  readonly live: boolean
  readonly attachedClientId: string | null
  readonly idleStopPolicy: {
    readonly tracking: boolean
    readonly unaccounted: boolean
    readonly onlyWaiting: boolean
    readonly unread: boolean
    readonly finished: boolean
  }
  stoppedBy: ProviderRelayStop
  close: () => Promise<unknown>
}

/**
 * The detached cap for the whole daemon, on one timer at the earliest deadline: a relay detached
 * this long with unread output, or with work the idle stop can't see, is stopped (its spool stays).
 * Busy work is never stopped, so only a relay that went idle with unread output, or whose work is
 * unknown, counts; nothing rechecks a busy one, which counts again at its next idle-with-unread.
 */
export class ProviderRelayDetachedCap {
  private readonly detachedAt = new Map<CappableRelay, number>()
  /** Detached relays the cap counts: work unknown, or idle with unread output. */
  private readonly counted = new Set<CappableRelay>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt: number | null = null

  constructor(
    private readonly log: (event: string, details: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** The last client let go; only a running agent has anything to cap. */
  detached(relay: CappableRelay): void {
    if (relay.live && relay.attachedClientId === null) {
      this.detachedAt.set(relay, this.now())
      const policy = relay.idleStopPolicy
      if (!policy.tracking || policy.unaccounted || policy.onlyWaiting) {
        this.count(relay)
      }
    }
  }

  /** Just spawned: its first attach forgets it, or it ends as unclaimed. */
  spawned(relay: CappableRelay): void {
    this.detachedAt.set(relay, this.now() - RELAY_DETACHED_CAP_MS + RELAY_UNCLAIMED_MS)
    this.count(relay)
  }

  /** The idle stop found it idle but for unread output. */
  idleUnread(relay: CappableRelay): void {
    if (this.detachedAt.has(relay) && !this.counted.has(relay)) {
      this.count(relay)
    }
  }

  /** Attached again, or ended: no deadline. The timer stays until it fires (it rescans then). */
  forget(relay: CappableRelay): void {
    this.counted.delete(relay)
    this.detachedAt.delete(relay)
    if (this.counted.size === 0) {
      this.clearTimer()
    }
  }

  stop(): void {
    this.detachedAt.clear()
    this.counted.clear()
    this.clearTimer()
  }

  /** O(1): a new deadline only ever moves the one timer earlier. */
  private count(relay: CappableRelay): void {
    this.counted.add(relay)
    const due = this.detachedAt.get(relay)! + RELAY_DETACHED_CAP_MS
    if (this.dueAt === null || due < this.dueAt) {
      this.arm(due)
    }
  }

  /** The full rescan, only when the timer fires. */
  private update(): void {
    let earliest: number | null = null
    for (const relay of this.counted) {
      const due = this.detachedAt.get(relay)! + RELAY_DETACHED_CAP_MS
      earliest = earliest === null ? due : Math.min(earliest, due)
    }
    if (earliest === this.dueAt) {
      return
    }
    this.clearTimer()
    if (earliest !== null) {
      this.arm(earliest)
    }
  }

  private arm(due: number): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.dueAt = due
    this.timer = setTimeout(() => this.fire(), Math.max(0, due - this.now()))
    this.timer.unref?.()
  }

  private forgetQuietly(relay: CappableRelay): void {
    this.counted.delete(relay)
    this.detachedAt.delete(relay)
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = null
    this.dueAt = null
  }

  private fire(): void {
    this.timer = null
    this.dueAt = null
    const now = this.now()
    for (const relay of this.counted) {
      const at = this.detachedAt.get(relay)!
      if (!relay.live || relay.attachedClientId !== null) {
        this.forgetQuietly(relay)
        continue
      }
      if (now - at < RELAY_DETACHED_CAP_MS) {
        continue
      }
      const policy = relay.idleStopPolicy
      // Busy again since it counted: not stopped, and not counted until it is idle with unread again.
      const capped = policy.unaccounted || policy.onlyWaiting || (policy.unread && policy.finished)
      if (policy.tracking && !capped) {
        this.counted.delete(relay)
        continue
      }
      this.forgetQuietly(relay)
      relay.stoppedBy = policy.finished ? 'cap-finished' : 'cap'
      this.log('relay-cap-stop', { relayId: relay.relayId, unread: policy.unread })
      void relay.close().catch(() => {})
    }
    this.update()
  }
}
