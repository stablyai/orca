import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const DIRECT_PROBE_INTERVAL_MS = 15_000

// While the runtime channel rides the relay, periodically probe the direct
// endpoint and migrate back once hysteresis proves it stable.
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
      canAttempt: () => boolean
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
    if (!this.hooks.canAttempt() || !this.hooks.hysteresis.canProbe(this.deps.now())) {
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
      // that landed during a foreground return. Only the cutover needs the mutex.
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
      if (!this.hooks.hysteresis.recordDirectSuccess(this.deps.now())) {
        return
      }
      if (!this.hooks.canAttempt()) {
        // A relay dial owns the mutex; the streak survives, so the next probe
        // promotes direct instead of this one.
        return
      }
      this.hooks.beginOperation()
      owned = true
      const candidate = successful
      // Migration owns the candidate, including closing it if cutover is canceled.
      successful = null
      try {
        await this.hooks.migrate(candidate.client, candidate.path, () => this.stopped)
      } catch (error) {
        if (this.stopped) {
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
