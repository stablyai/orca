import { classifyRemotePairingHostname } from '../../../../src/shared/remote-runtime/pairing/remote-pairing-address'
import {
  openPreferredDirectCandidate,
  type DirectCandidate
} from './mobile-preferred-direct-candidate'
import {
  ARRIVAL_OBSERVATION_MS,
  type MobileEndpointHysteresis
} from '../connection/mobile-endpoint-hysteresis'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { ScheduleTimer } from '../../platform/timer-scheduler'
import type { MobileConnectionPath } from '../connection/stable-logical-rpc-client'

const DIRECT_PROBE_INTERVAL_MS = 15_000
// After a network change the relay redial holds the mutex for about a second.
const ARRIVAL_BLOCKED_RETRY_MS = 500

// A private-address host authenticates well inside 4 s, and a longer bound only holds the probe mutex while away.
// Tailscale, public and custom hosts can cross a slow internet route, so they keep the socket's own 12 s.
export function directProbeTimeoutMsForEndpoint(endpoint: string): number {
  try {
    const kind = classifyRemotePairingHostname(new URL(endpoint).hostname)
    return kind === 'lan' || kind === 'loopback' ? 4_000 : 12_000
  } catch {
    return 12_000
  }
}

export class DirectReturnProbe {
  private timer: ReturnType<typeof setTimeout> | null = null

  private stopped = false
  private activeProbe: AbortController | null = null
  private observedPath: MobileConnectionPath | null = null

  constructor(
    private readonly deps: {
      now: () => number
      setTimer: ScheduleTimer
      clearTimer: typeof clearTimeout
      openDirect: () => RpcClient
      directPath: Exclude<MobileConnectionPath, 'relay'>
      directProbeTimeoutMs: number
      directCandidates?: () => readonly DirectCandidate[]
    },
    private readonly hooks: {
      hysteresis: MobileEndpointHysteresis
      activePath?: () => MobileConnectionPath
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

  schedule(delayMs = this.intervalMs()): void {
    if (
      this.stopped ||
      !this.hooks.canSchedule() ||
      this.timer ||
      (this.hooks.activePath?.() === 'tailscale' &&
        delayMs > 0 &&
        !this.hooks.hysteresis.isArrival())
    ) {
      return
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.probe()
    }, delayMs)
  }

  // A dial begun on the previous network can only time out, so drop it uncounted and probe now.
  arrive(): void {
    if (this.stopped) {
      return
    }
    this.hooks.hysteresis.recordNetworkArrival()
    this.activeProbe?.abort()
    this.clear()
    if (this.hooks.canSchedule()) {
      this.schedule(this.hooks.hysteresis.arrivalWaitMs(this.deps.now()))
    }
  }

  clear(): void {
    if (this.timer) {
      this.deps.clearTimer(this.timer)
      this.timer = null
    }
  }

  pause(): void {
    this.clear()
    this.activeProbe?.abort()
  }

  stop(): void {
    this.stopped = true
    this.clear()
    this.activeProbe?.abort()
  }

  private async probe(): Promise<void> {
    if (this.stopped || !this.hooks.canSchedule()) {
      return
    }
    if (!this.hooks.canAttempt() || !this.hooks.hysteresis.canProbe(this.deps.now())) {
      this.schedule(this.hooks.hysteresis.isArrival() ? ARRIVAL_BLOCKED_RETRY_MS : undefined)
      return
    }
    const startingPath = this.hooks.activePath?.()
    const controller = new AbortController()
    this.activeProbe = controller
    this.hooks.beginOperation()
    let successful: Awaited<ReturnType<typeof openPreferredDirectCandidate>> = null
    try {
      successful = await openPreferredDirectCandidate(
        this.deps.directCandidates?.() ?? [
          {
            path: this.deps.directPath,
            open: this.deps.openDirect,
            timeoutMs: this.deps.directProbeTimeoutMs
          }
        ],
        controller.signal
      )
      if (
        this.stopped ||
        controller.signal.aborted ||
        !this.hooks.canSchedule() ||
        this.hooks.activePath?.() !== startingPath
      ) {
        return
      }
      if (!successful) {
        this.observedPath = null
        this.hooks.hysteresis.recordDirectFailure(this.deps.now())
        return
      }
      if (this.observedPath !== successful.path) {
        this.hooks.hysteresis.resetDirectObservation()
        this.observedPath = successful.path
      }
      if (!this.hooks.hysteresis.recordDirectSuccess(this.deps.now())) {
        successful.client.close()
        return
      }
      const candidate = successful
      // Migration owns the candidate, including closing it if cutover is canceled.
      successful = null
      try {
        await this.hooks.migrate(
          candidate.client,
          candidate.path,
          () =>
            this.stopped ||
            controller.signal.aborted ||
            !this.hooks.canSchedule() ||
            this.hooks.activePath?.() !== startingPath
        )
      } catch (error) {
        if (this.stopped) {
          return
        }
        throw error
      }
      if (this.stopped) {
        return
      }
      this.hooks.hysteresis.recordDirectMigration(this.deps.now())
      await this.hooks.onDirectMigrated()
    } finally {
      this.activeProbe = null
      successful?.client.close()
      // Release the probe mutex and replay recovery queued by a concurrent relay drop/backoff timer.
      this.hooks.afterProbe()
      this.schedule()
    }
  }

  private intervalMs(): number {
    const { hysteresis } = this.hooks
    return hysteresis.isArrival()
      ? Math.max(ARRIVAL_OBSERVATION_MS, hysteresis.arrivalWaitMs(this.deps.now()))
      : DIRECT_PROBE_INTERVAL_MS
  }
}
