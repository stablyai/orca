import { openAuthenticatedDirectEndpoint } from '../relay/mobile-direct-endpoint-probe'
import { DirectReturnProbe } from '../relay/mobile-direct-return-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import { defaultCancelTimer, defaultScheduleTimer } from '../../platform/timer-scheduler'
import type { ForegroundNudgeReason } from './connection-state'
import type { RpcClient } from '../rpc/rpc-client-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

const PROBE_TIMEOUT_MS = 12_000
const RETRY_DELAY_MS = 15_000
// A short LAN blip usually recovers on its own; don't migrate paths for it.
const RECONNECT_GRACE_MS = 2_000
// A burst of nudges (Android can fire several network-change events at once) must not become a burst of dials.
const MIN_NUDGE_GAP_MS = 3_000

// All candidate addresses were learned from the authenticated desktop or initial pairing.
export class MobileDirectTailnetFallback {
  private stopped = false
  private foreground = true
  private activeProbe: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private lastProbeStartedAt = Number.NEGATIVE_INFINITY
  private unsubscribe: (() => void) | null = null
  private lastLanReturnNudgeAt = Number.NEGATIVE_INFINITY
  private readonly lanReturnProbe: DirectReturnProbe | null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly openDirect: (path: 'lan' | 'tailscale') => RpcClient,
    enableHealthyLanReturn = false
  ) {
    this.lanReturnProbe = enableHealthyLanReturn
      ? new DirectReturnProbe(
          {
            now: Date.now,
            setTimer: defaultScheduleTimer,
            clearTimer: defaultCancelTimer,
            openDirect: () => this.openDirect('lan'),
            directPath: 'lan',
            directProbeTimeoutMs: 4_000
          },
          {
            hysteresis: new MobileEndpointHysteresis(Date.now()),
            activePath: () => this.logical.getActivePath(),
            canSchedule: () =>
              !this.stopped &&
              this.foreground &&
              this.logical.getState() === 'connected' &&
              this.logical.getActivePath() === 'tailscale',
            canAttempt: () => true,
            beginOperation: () => {},
            migrate: (client, path, abort) =>
              this.logical.migrateTo(client, path, undefined, abort),
            onDirectMigrated: async () => {},
            afterProbe: () => {}
          }
        )
      : null
  }

  start(): void {
    this.unsubscribe = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        this.clearRetry()
        this.clearGrace()
        this.cancelProbe()
        return
      }
      if (state === 'reconnecting' && !this.retryTimer && !this.graceTimer && !this.activeProbe) {
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null
          this.tryFallback()
        }, RECONNECT_GRACE_MS)
      }
    })
    // Already reconnecting at start (cold open off the LAN): the primary has had its chance, so probe now.
    if (this.logical.getState() === 'reconnecting') {
      this.tryFallback()
    } else {
      this.tryLanReturn()
    }
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foreground
    this.foreground = foreground
    if (!foreground) {
      this.cancelProbe()
      this.clearRetry()
      this.clearGrace()
      this.lanReturnProbe?.pause()
    } else if (this.logical.getState() === 'reconnecting') {
      this.clearRetry()
      this.tryFallback()
    } else if (!wasForeground) {
      this.tryLanReturn()
    }
  }

  nudge(reason?: ForegroundNudgeReason): void {
    if (this.logical.getState() === 'connected') {
      if (reason) {
        this.tryLanReturn()
      }
      return
    }
    if (Date.now() - this.lastProbeStartedAt < MIN_NUDGE_GAP_MS) {
      return
    }
    this.clearRetry()
    this.tryFallback()
  }

  private tryLanReturn(): void {
    if (
      !this.lanReturnProbe ||
      this.stopped ||
      !this.foreground ||
      this.logical.getState() !== 'connected' ||
      this.logical.getActivePath() !== 'tailscale' ||
      Date.now() - this.lastLanReturnNudgeAt < MIN_NUDGE_GAP_MS
    ) {
      return
    }
    this.lastLanReturnNudgeAt = Date.now()
    this.lanReturnProbe.arrive()
  }

  stop(): void {
    this.stopped = true
    this.lanReturnProbe?.stop()
    this.cancelProbe()
    this.clearRetry()
    this.clearGrace()
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private tryFallback(): void {
    if (
      this.stopped ||
      !this.foreground ||
      this.activeProbe ||
      this.logical.getActivePath() === 'relay' ||
      this.logical.getState() === 'connected' ||
      this.logical.getState() === 'auth-failed' ||
      this.logical.getState() === 'disconnected'
    ) {
      return
    }
    this.clearRetry()
    this.clearGrace()
    const controller = new AbortController()
    this.activeProbe = controller
    this.lastProbeStartedAt = Date.now()
    const generation = this.logical.getGeneration()
    const alternatePath = this.logical.getActivePath() === 'tailscale' ? 'lan' : 'tailscale'
    void this.probe(controller, generation, alternatePath)
  }

  private async probe(
    controller: AbortController,
    generation: number,
    alternatePath: 'lan' | 'tailscale'
  ): Promise<void> {
    let candidate: RpcClient | null = null
    try {
      candidate = await openAuthenticatedDirectEndpoint(
        () => this.openDirect(alternatePath),
        PROBE_TIMEOUT_MS,
        controller.signal
      )
      if (
        !candidate ||
        controller.signal.aborted ||
        this.stopped ||
        !this.foreground ||
        this.logical.getGeneration() !== generation ||
        this.logical.getState() === 'connected' ||
        this.logical.getActivePath() === alternatePath
      ) {
        return
      }
      const authenticated = candidate
      candidate = null
      await this.logical.migrateTo(
        authenticated,
        alternatePath,
        PROBE_TIMEOUT_MS,
        () =>
          controller.signal.aborted ||
          this.stopped ||
          !this.foreground ||
          this.logical.getGeneration() !== generation ||
          this.logical.getState() === 'connected'
      )
    } catch {
      // A failed backup must not disrupt the current direct reconnect loop.
    } finally {
      candidate?.close()
      if (this.activeProbe === controller) {
        this.activeProbe = null
        if (
          !this.stopped &&
          this.foreground &&
          this.logical.getState() !== 'connected' &&
          this.logical.getState() !== 'auth-failed'
        ) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null
            this.tryFallback()
          }, RETRY_DELAY_MS)
        }
      }
    }
  }

  private cancelProbe(): void {
    this.activeProbe?.abort()
    this.activeProbe = null
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}
