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
/** A relay past the cap but still busy and fully read is looked at again this often. */
const RECHECK_MS = 60 * 60 * 1000

export type CappableRelay = {
  readonly relayId: string
  readonly live: boolean
  readonly attachedClientId: string | null
  readonly idleStopPolicy: {
    readonly tracking: boolean
    readonly unread: boolean
    readonly finished: boolean
  }
  stoppedBy: ProviderRelayStop
  close: () => Promise<unknown>
}

/**
 * The detached cap for the whole daemon, on one timer at the earliest deadline: a relay detached
 * this long with unread output, or with work the idle stop can't see, is stopped (its spool stays).
 */
export class ProviderRelayDetachedCap {
  private readonly detachedAt = new Map<CappableRelay, number>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private dueAt: number | null = null
  private recheckAt = 0

  constructor(
    private readonly log: (event: string, details: Record<string, unknown>) => void,
    private readonly now: () => number = Date.now
  ) {}

  /** The last client let go; only a running agent has anything to cap. */
  detached(relay: CappableRelay): void {
    if (relay.live && relay.attachedClientId === null) {
      this.detachedAt.set(relay, this.now())
      this.update()
    }
  }

  /** Attached again, or ended: no deadline. */
  forget(relay: CappableRelay): void {
    if (this.detachedAt.delete(relay)) {
      this.update()
    }
  }

  stop(): void {
    this.detachedAt.clear()
    this.clearTimer()
  }

  private update(): void {
    let earliest: number | null = null
    for (const at of this.detachedAt.values()) {
      const due = Math.max(at + RELAY_DETACHED_CAP_MS, this.recheckAt)
      earliest = earliest === null ? due : Math.min(earliest, due)
    }
    if (earliest === this.dueAt) {
      return
    }
    this.clearTimer()
    if (earliest !== null) {
      this.dueAt = earliest
      this.timer = setTimeout(() => this.fire(), Math.max(0, earliest - this.now()))
      this.timer.unref?.()
    }
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
    this.recheckAt = now + RECHECK_MS
    for (const [relay, at] of this.detachedAt) {
      if (!relay.live || relay.attachedClientId !== null) {
        this.detachedAt.delete(relay)
        continue
      }
      const policy = relay.idleStopPolicy
      if (now - at >= RELAY_DETACHED_CAP_MS && (!policy.tracking || policy.unread)) {
        this.detachedAt.delete(relay)
        relay.stoppedBy = policy.finished ? 'cap-finished' : 'cap'
        this.log('relay-cap-stop', { relayId: relay.relayId, unread: policy.unread })
        void relay.close().catch(() => {})
      }
    }
    this.update()
  }
}
