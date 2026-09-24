import { MobileDirectEndpointDiscovery } from './mobile-direct-endpoint-discovery'
import { openAuthenticatedDirectEndpoint } from './mobile-direct-endpoint-probe'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason, HostProfile } from './types'

const FALLBACK_RETRY_MS = 15_000

// Keep the configured WebSocket URL as the bootstrap and recovery route after a LAN promotion.
export class MobileCustomEndpointSupervisor {
  private readonly discovery = new MobileDirectEndpointDiscovery()
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly directProbe: DirectReturnProbe
  private foreground = true
  private stopped = false
  private onBootstrap = true
  private operationInFlight = false
  private fallbackProbe: AbortController | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAt = 0
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly host: HostProfile,
    private readonly deps: Pick<
      MobileEndpointSupervisorDependencies,
      'openDirect' | 'now' | 'setTimer' | 'clearTimer'
    >
  ) {
    this.hysteresis = new MobileEndpointHysteresis(deps.now())
    this.directProbe = new DirectReturnProbe(deps, {
      hysteresis: this.hysteresis,
      host: () => host,
      resolveHost: (signal) => this.resolveProbeHost(signal),
      canSchedule: () => this.isActive() && this.onBootstrap && logical.getState() === 'connected',
      canAttempt: () => this.isActive() && !this.operationInFlight,
      beginOperation: () => {
        this.operationInFlight = true
      },
      migrate: (client, path, abort) => logical.migrateTo(client, path, undefined, abort),
      onDirectMigrated: async () => {
        this.onBootstrap = false
      },
      afterProbe: () => {
        this.operationInFlight = false
        this.reconcile()
      }
    })
  }

  async start(): Promise<void> {
    this.unsubscribe = this.logical.onStateChange(() => this.reconcile())
    this.reconcile()
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (!foreground) {
      this.directProbe.cancel()
      this.clearRetry()
      this.fallbackProbe?.abort()
    } else {
      this.reconcile()
    }
  }

  nudge(reason: ForegroundNudgeReason): void {
    if (reason !== 'network-change') {
      this.setForeground(true)
    }
    if (!this.isActive()) {
      return
    }
    this.directProbe.clear()
    this.directProbe.schedule(0)
    this.reconcile()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.directProbe.stop()
    this.clearRetry()
    this.fallbackProbe?.abort()
  }

  private isActive(): boolean {
    return !this.stopped && this.foreground
  }

  private async resolveProbeHost(signal: AbortSignal): Promise<HostProfile | null> {
    const discovered = await this.discovery.getProbeHost(this.logical, this.host, signal)
    const endpoints = discovered?.endpoints?.filter(
      ({ kind, url }) => kind !== 'relay' && url !== this.host.endpoint
    )
    const first = endpoints?.[0]
    // Never promote the bootstrap URL to itself, including when an older host refuses discovery.
    return discovered && first ? { ...discovered, endpoint: first.url, endpoints } : null
  }

  private reconcile(): void {
    if (!this.isActive() || this.operationInFlight) {
      return
    }
    if (this.logical.getState() === 'connected') {
      this.clearRetry()
      this.directProbe.schedule()
    } else if (!this.onBootstrap && !this.retryTimer) {
      this.retryTimer = this.deps.setTimer(
        () => {
          this.retryTimer = null
          void this.recoverBootstrap()
        },
        Math.max(0, this.retryAt - this.deps.now())
      )
    }
  }

  private clearRetry(): void {
    if (this.retryTimer) {
      this.deps.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
  }

  private async recoverBootstrap(): Promise<void> {
    if (
      !this.isActive() ||
      this.operationInFlight ||
      this.onBootstrap ||
      this.logical.getState() === 'connected'
    ) {
      return
    }
    this.operationInFlight = true
    const controller = new AbortController()
    this.fallbackProbe = controller
    try {
      const candidate = await openAuthenticatedDirectEndpoint(
        { ...this.host, endpoints: [] },
        this.deps.openDirect,
        12_000,
        controller.signal
      )
      if (!candidate) {
        if (!controller.signal.aborted) {
          this.retryAt = this.deps.now() + FALLBACK_RETRY_MS
        }
        return
      }
      const shouldAbort = (): boolean =>
        controller.signal.aborted || !this.isActive() || this.logical.getState() === 'connected'
      if (shouldAbort()) {
        candidate.client.close()
        return
      }
      await this.logical.migrateTo(candidate.client, candidate.path, undefined, shouldAbort)
      this.onBootstrap = true
      this.retryAt = 0
      this.hysteresis.recordMigration(this.deps.now())
    } catch {
      if (!controller.signal.aborted) {
        this.retryAt = this.deps.now() + FALLBACK_RETRY_MS
      }
    } finally {
      this.fallbackProbe = null
      this.operationInFlight = false
      this.reconcile()
    }
  }
}
