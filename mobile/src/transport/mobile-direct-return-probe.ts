import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import type { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { RpcClient } from './rpc-client'
import type { ScheduleTimer } from './timer-scheduler'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

const DIRECT_PROBE_INTERVAL_MS = 15_000
// The relay session's request timeout is 30s. This probe holds the operation
// mutex, so a refresh that never answers must not delay the direct dial by that long.
export const DIRECT_REFRESH_BUDGET_MS = 2_000

// While the runtime channel rides the relay, periodically probe the direct
// endpoint and migrate back once hysteresis proves it stable.
export class DirectReturnProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  private stopped = false
  private activeProbe: AbortController | null = null

  constructor(
    private readonly deps: {
      now: () => number
      setTimer: ScheduleTimer
      clearTimer: typeof clearTimeout
      openDirect: () => RpcClient
      directPath: () => Exclude<MobileConnectionPath, 'relay'>
    },
    private readonly hooks: {
      hysteresis: MobileEndpointHysteresis
      refreshDirectEndpoints: () => Promise<void>
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
    this.hooks.beginOperation()
    let successful: Awaited<ReturnType<typeof openAuthenticatedDirectEndpoint>> = null
    try {
      // Why: bound the refresh, then dial the saved endpoint if it is still in flight.
      await this.refreshWithinBudget(controller.signal)
      if (this.stopped || controller.signal.aborted) {
        return
      }
      const directPath = this.deps.directPath()
      successful = await openAuthenticatedDirectEndpoint(
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
      if (!this.hooks.hysteresis.recordDirectSuccess(this.deps.now())) {
        successful.close()
        return
      }
      const candidate = successful
      // Migration owns the candidate, including closing it if cutover is canceled.
      successful = null
      try {
        await this.hooks.migrate(candidate, directPath, () => this.stopped)
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
      successful?.close()
      // Why: a relay drop or backoff timer can arrive while the probe owns the
      // operation mutex; afterProbe releases it and replays deferred recovery.
      this.hooks.afterProbe()
      this.schedule()
    }
  }

  private refreshWithinBudget(signal: AbortSignal): Promise<void> {
    if (this.stopped || signal.aborted) {
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        if (timer) {
          this.deps.clearTimer(timer)
        }
        signal.removeEventListener('abort', finish)
        resolve()
      }
      timer = this.deps.setTimer(finish, DIRECT_REFRESH_BUDGET_MS)
      signal.addEventListener('abort', finish)
      void this.hooks.refreshDirectEndpoints().then(finish, finish)
    })
  }
}
