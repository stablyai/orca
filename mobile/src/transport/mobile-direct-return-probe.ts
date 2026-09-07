import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const DIRECT_PROBE_INTERVAL_MS = 15_000

// Re-acquires the direct endpoint while the runtime channel rides the relay.
// Two adoption policies, because what is at stake differs:
//   - against a live relay, hysteresis must prove direct stable before the swap;
//   - during a reconnect nothing is live, so this dial races the relay dial from
//     t=0 and the first authenticated socket is adopted outright.
export class DirectReturnProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  private stopped = false
  private activeProbe: AbortController | null = null
  // Soonest delay a caller asked for while a dial was in flight.
  private deferredDelayMs: number | null = null

  constructor(
    private readonly deps: {
      now: () => number
      setTimer: typeof setTimeout
      clearTimer: typeof clearTimeout
      openDirect: (endpoint: string) => RpcClient
    },
    private readonly hooks: {
      hysteresis: MobileEndpointHysteresis
      host: () => HostProfile
      canSchedule: () => boolean
      // A dial is a pure observation on its own socket, so it only needs a live
      // supervisor; the cutover is the part that needs the operation mutex.
      canDial: () => boolean
      canAttempt: () => boolean
      // True while no session is live: the reconnect is a race, so an
      // authenticated direct socket wins without consulting hysteresis.
      adoptsOutright: () => boolean
      // Takes the supervisor's operation mutex, now held for the cutover only.
      beginOperation: () => void
      migrate: (
        client: RpcClient,
        path: MobileConnectionPath,
        shouldAbort: () => boolean
      ) => Promise<void>
      onDirectMigrated: () => Promise<void>
      afterProbe: () => void
    }
  ) {}

  schedule(delayMs = DIRECT_PROBE_INTERVAL_MS): void {
    if (this.stopped || !this.hooks.canSchedule()) {
      return
    }
    // Why: the dial no longer holds the supervisor's mutex, so nothing else stops a
    // second probe from overwriting activeProbe — stop() would then reach only the
    // newest socket and leave the earlier one dialing for its full 12s budget. The
    // in-flight probe owns the next slot and re-arms it on the soonest ask.
    if (this.activeProbe) {
      this.deferredDelayMs = Math.min(this.deferredDelayMs ?? delayMs, delayMs)
      return
    }
    if (this.timer) {
      return
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.probe()
    }, delayMs)
  }

  // Why: a reconnect races both paths from t=0, and schedule(0) yields to a
  // pending 15s tick — that would hand the relay dial a head start by another name.
  probeNow(): void {
    if (this.stopped || this.activeProbe) {
      return
    }
    this.clear()
    this.schedule(0)
  }

  clear(): void {
    this.deferredDelayMs = null
    if (this.timer) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    this.stopped = true
    this.clear()
    this.activeProbe?.abort()
  }

  private async probe(): Promise<void> {
    if (this.stopped) {
      return
    }
    // Why: the failure cooldown exists to stop a healthy relay flapping onto a
    // marginal LAN. With nothing connected there is no session to protect, and
    // honouring it would leave the phone waiting on relay alone.
    const racing = this.hooks.adoptsOutright()
    if (!this.hooks.canDial() || (!racing && !this.hooks.hysteresis.canProbe(this.deps.now()))) {
      this.schedule()
      return
    }
    const controller = new AbortController()
    this.activeProbe = controller
    let owned = false
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      // Why: the dial is a pure observation on its own socket — holding the
      // supervisor's mutex across its 12s budget stalled every relay recovery
      // that landed during a foreground return, and makes the reconnect race
      // unwinnable while a relay dial holds it.
      successful = await openAuthenticatedDirectEndpoint(
        this.hooks.host(),
        this.deps.openDirect,
        12_000,
        controller.signal
      )
      if (this.stopped) {
        return
      }
      if (!successful) {
        this.hooks.hysteresis.recordDirectFailure(this.deps.now())
        return
      }
      // Both early returns leave the candidate to the finally, which owns it until
      // migration takes over — closing here too would double-close it.
      const outright = this.hooks.adoptsOutright()
      // Why: a socket that entered the race and lost books nothing and leaves the
      // promotion streak untouched — the winner is this reconnect's whole verdict.
      if (!outright && (racing || !this.hooks.hysteresis.recordDirectSuccess(this.deps.now()))) {
        return
      }
      const mutexFree = this.hooks.canAttempt()
      if (!mutexFree && !outright) {
        // A relay dial owns the mutex; the streak survives, so the next probe
        // promotes direct instead of this one.
        return
      }
      if (mutexFree) {
        this.hooks.beginOperation()
        owned = true
      }
      // Why: when a relay dial holds the mutex the race still cuts over — that
      // dial withdraws itself in migrateTo and books no failure against relay.
      const candidate = successful
      // Migration owns the candidate, including closing it if cutover is canceled.
      successful = null
      // Why: the relay dial can authenticate between this socket's authentication
      // and the swap. migrateTo re-checks after auth, so the loser withdraws.
      const abortCutover = outright
        ? (): boolean => this.stopped || !this.hooks.adoptsOutright()
        : (): boolean => this.stopped
      try {
        await this.hooks.migrate(candidate.client, candidate.path, abortCutover)
      } catch (error) {
        // Why: a withdrawn cutover is the ordinary end of a lost race, and
        // migrateTo has already closed the candidate. Only the timer calls this
        // method, and it discards the promise, so rethrowing here would surface
        // a routine loss as an unhandled rejection.
        if (this.stopped || abortCutover()) {
          return
        }
        throw error
      }
      if (this.stopped) {
        return
      }
      this.hooks.hysteresis.recordMigration(this.deps.now())
      await this.hooks.onDirectMigrated()
    } finally {
      this.activeProbe = null
      successful?.client.close()
      // Why: a relay drop or backoff timer can arrive while the cutover owns the
      // operation mutex; afterProbe releases it and replays deferred recovery.
      if (owned) {
        this.hooks.afterProbe()
      }
      const deferred = this.deferredDelayMs
      this.deferredDelayMs = null
      this.schedule(deferred ?? undefined)
    }
  }
}
