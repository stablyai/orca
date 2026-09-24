import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { RpcClient } from './rpc-client'
import type { ScheduleTimer } from './timer-scheduler'
import type { HostProfile } from './types'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const DIRECT_PROBE_INTERVAL_MS = 15_000

// While the runtime channel rides the relay, periodically probe the direct
// endpoint and migrate back once hysteresis proves it stable.
export class DirectReturnProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  private stopped = false
  private activeProbe: AbortController | null = null
  private candidateSnapshot: string | null = null

  constructor(
    private readonly deps: {
      now: () => number
      setTimer: ScheduleTimer
      clearTimer: typeof clearTimeout
      openDirect: (endpoint: string) => RpcClient
    },
    private readonly hooks: {
      hysteresis: MobileEndpointHysteresis
      host: () => HostProfile
      resolveHost?: (signal: AbortSignal) => Promise<HostProfile | null>
      canSchedule: () => boolean
      canAttempt: () => boolean
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
    if (this.stopped || !this.hooks.canSchedule() || this.timer) {
      return
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.probe()
    }, delayMs)
  }

  clear(): void {
    if (this.timer) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
  }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  cancel(): void {
    this.clear()
    this.activeProbe?.abort()
  }

  private async probe(): Promise<void> {
    if (this.stopped || !this.hooks.canSchedule()) {
      return
    }
    if (!this.hooks.canAttempt() || !this.hooks.hysteresis.canProbe(this.deps.now())) {
      this.schedule()
      return
    }
    const controller = new AbortController()
    this.activeProbe = controller
    this.hooks.beginOperation()
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      const host = this.hooks.resolveHost
        ? await this.hooks.resolveHost(controller.signal)
        : this.hooks.host()
      const snapshot = host ? JSON.stringify([host.endpoint, host.endpoints]) : null
      if (snapshot !== this.candidateSnapshot) {
        this.hooks.hysteresis.resetDirectObservation()
        this.candidateSnapshot = snapshot
      }
      if (controller.signal.aborted || !host) {
        return
      }
      successful = await openAuthenticatedDirectEndpoint(
        host,
        this.deps.openDirect,
        12_000,
        controller.signal
      )
      if (controller.signal.aborted) {
        return
      }
      if (!successful) {
        this.hooks.hysteresis.recordDirectFailure(this.deps.now())
        return
      }
      if (!this.hooks.hysteresis.recordDirectSuccess(this.deps.now())) {
        successful.client.close()
        return
      }
      const candidate = successful
      // Migration owns the candidate, including closing it if cutover is canceled.
      successful = null
      try {
        await this.hooks.migrate(candidate.client, candidate.path, () => controller.signal.aborted)
      } catch {
        if (!controller.signal.aborted) {
          this.hooks.hysteresis.recordDirectFailure(this.deps.now())
        }
        return
      }
      if (this.stopped) {
        return
      }
      this.hooks.hysteresis.recordMigration(this.deps.now())
      await this.hooks.onDirectMigrated()
    } finally {
      this.activeProbe = null
      successful?.client.close()
      // Why: a relay drop or backoff timer can arrive while the probe owns the
      // operation mutex; afterProbe releases it and replays deferred recovery.
      this.hooks.afterProbe()
      this.schedule()
    }
  }
}
