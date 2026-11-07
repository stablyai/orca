import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import { trackDaemonRetired } from '../../observability/daemon-lifecycle-event'
import type { DaemonIdleRetirementResult } from '../adapter/daemon-pty-runtime-state'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'
import { DaemonPtyAdapterSubscriptionFanout } from './daemon-pty-adapter-subscription-fanout'

// Why: session exits arrive in bursts, and one retirement RPC answers the whole burst.
const LEGACY_DRAIN_DEBOUNCE_MS = 5_000

export type LegacyDaemonDrainRetirementDeps = {
  /** False for the current generation and for adapters already detached from the router. */
  isLegacyAdapter: (adapter: DaemonPtyAdapter) => boolean
  /** Local pre-check; the daemon re-verifies idleness server-side before retiring. */
  ownsRoutedSession: (adapter: DaemonPtyAdapter) => boolean
  requestIdleRetirement: (adapter: DaemonPtyAdapter) => Promise<DaemonIdleRetirementResult>
  detachAdapter: (adapter: DaemonPtyAdapter) => void
  debounceMs?: number
}

/**
 * Retires legacy-generation terminal daemons once their sessions have drained.
 *
 * The app keeps an authenticated event connection to every legacy adapter, so the
 * daemon-side "last client disconnected" retirement can never fire while the app
 * runs, and an upgrade-era daemon whose sessions all exited leaks until reboot
 * (#9138). The daemon's own `shutdownIfIdle` census stays authoritative: an
 * adapter with live sessions, in-flight admissions, or any other connected
 * client refuses, and we simply stay attached until the next drain signal.
 */
export class LegacyDaemonDrainRetirement {
  constructor(private readonly deps: LegacyDaemonDrainRetirementDeps) {}

  /** Debounced drain signal; wire to legacy session exits (the current adapter is ignored). */
  scheduleDrainCheck(adapter: DaemonPtyAdapter): void {
    if (this.disposed || !this.deps.isLegacyAdapter(adapter)) {
      return
    }
    const existing = this.timers.get(adapter)
    if (existing !== undefined) {
      clearTimeout(existing)
    }
    this.timers.set(
      adapter,
      setTimeout(() => {
        this.timers.delete(adapter)
        void this.retireIfDrained(adapter)
      }, this.deps.debounceMs ?? LEGACY_DRAIN_DEBOUNCE_MS)
    )
  }

  /** Startup sweep: retire drained generations immediately instead of waiting for an exit event. */
  sweepDrainedLegacyAdapters(adapters: readonly DaemonPtyAdapter[]): void {
    for (const adapter of adapters) {
      void this.retireIfDrained(adapter)
    }
  }

  /** Drops pending drain checks; call when the owning router is torn down (quit or restart swap). */
  dispose(): void {
    this.disposed = true
    this.pendingAfterFlight.clear()
    for (const handle of this.timers.values()) {
      clearTimeout(handle)
    }
    this.timers.clear()
  }

  /** One census attempt: local route check, then the daemon-side verdict decides detach vs stay. */
  private async retireIfDrained(adapter: DaemonPtyAdapter): Promise<void> {
    if (this.disposed) {
      return
    }
    if (this.checksInFlight.has(adapter)) {
      // Why: the in-flight census may predate this drain signal; the finally below retries it.
      this.pendingAfterFlight.add(adapter)
      return
    }
    if (!this.deps.isLegacyAdapter(adapter) || this.deps.ownsRoutedSession(adapter)) {
      return
    }
    this.checksInFlight.add(adapter)
    let result: DaemonIdleRetirementResult
    try {
      result = await this.deps.requestIdleRetirement(adapter)
    } catch (error) {
      // Why: a drain check fires from event callbacks; it must never surface as a rejection there.
      console.warn('[daemon] legacy drain retirement check failed', { error: String(error) })
      return
    } finally {
      this.checksInFlight.delete(adapter)
      if (!this.disposed && this.pendingAfterFlight.delete(adapter)) {
        this.scheduleDrainCheck(adapter)
      }
    }
    // Why: the router may have been replaced (restart) while the census ran.
    if (this.disposed || !this.deps.isLegacyAdapter(adapter)) {
      return
    }
    if (result.state === 'retiring') {
      trackDaemonRetired('drained_legacy')
      this.deps.detachAdapter(adapter)
    }
    // busy / unverifiable / unsupported: stay attached; the next drain signal or startup retries.
  }

  private readonly timers = new Map<DaemonPtyAdapter, ReturnType<typeof setTimeout>>()
  private readonly checksInFlight = new Set<DaemonPtyAdapter>()
  // Why: a signal arriving mid-census must survive a busy/unverifiable verdict (#29970 review).
  private readonly pendingAfterFlight = new Set<DaemonPtyAdapter>()
  private disposed = false
}

export type LegacyDrainRouterArgs = {
  adapters: readonly DaemonPtyAdapter[]
  legacy: DaemonPtyAdapter[]
  sessionAdapters: Map<string, DaemonPtyAdapter>
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
}

/** Builds the router's adapter fanout together with its legacy drain retirement (wired to the fanout's exit events). */
export function createLegacyDrainFanout(args: LegacyDrainRouterArgs): {
  drain: LegacyDaemonDrainRetirement
  fanout: DaemonPtyAdapterSubscriptionFanout
} {
  let fanout: DaemonPtyAdapterSubscriptionFanout
  const drain = new LegacyDaemonDrainRetirement({
    isLegacyAdapter: (adapter) => args.legacy.includes(adapter),
    ownsRoutedSession: (adapter) => [...args.sessionAdapters.values()].includes(adapter),
    requestIdleRetirement: (adapter) => adapter.requestIdleRetirement(),
    detachAdapter: (adapter) =>
      detachLegacyAdapter(args.legacy, args.ownerResolver, fanout, adapter)
  })
  fanout = new DaemonPtyAdapterSubscriptionFanout(
    args.adapters,
    // Why owner-only: another generation's exit for a reused id must not unroute a live legacy session.
    (id, adapter) => {
      args.ownerResolver.forgetRoute(id, adapter)
      drain.scheduleDrainCheck(adapter)
    },
    (adapter) => args.ownerResolver.invalidateProvider(adapter)
  )
  return { drain, fanout }
}

// Why: the resolver and fanout were built from a copy of the adapters list; splicing
// the legacy array alone leaves them querying the detached socket.
export function detachLegacyAdapter(
  legacy: DaemonPtyAdapter[],
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>,
  subscriptions: DaemonPtyAdapterSubscriptionFanout,
  adapter: DaemonPtyAdapter
): void {
  const index = legacy.indexOf(adapter)
  if (index !== -1) {
    legacy.splice(index, 1)
    ownerResolver.invalidateProvider(adapter)
    subscriptions.dropAdapter(adapter)
  }
  // Why: best-effort — the daemon may already be closing its endpoint.
  void Promise.resolve()
    .then(() => adapter.disconnectOnly())
    .catch(() => undefined)
}
