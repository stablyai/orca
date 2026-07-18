import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { remainingRouteMs } from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileRelayCredentialRotationController } from './mobile-relay-credential-rotation-controller'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { MobileRelayHostPersistence } from './mobile-relay-host-persistence'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import { orderedHostAccessRoutes } from './mobile-access-route-order'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import type { RpcClient } from './rpc-client'
import {
  LogicalClientAuthenticationError,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'
import type { HostProfile, MobileAccessEndpoint } from './types'
import { MobileEndpointReconnectPolicy } from './mobile-endpoint-reconnect-policy'
import { MobileEndpointSupervisorTimers } from './mobile-endpoint-supervisor-timers'
import { MobileRelayCredentialBundleLoader } from './mobile-relay-credential-bundle-loader'
import { MobileRelayOrderedRouteAttempt } from './mobile-relay-ordered-route-attempt'

const ROUTE_AUTH_TIMEOUT_MS = 3_500
const RECONNECT_PASS_TIMEOUT_MS = 20_000

export type MobileEndpointSupervisorDependencies = {
  openDirect: (endpoint: string) => RpcClient
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: typeof resolveMobileRelayEndpoint
  readBundle: (hostId: string) => Promise<MobileRelayCredentialBundle | null>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  deleteBundle: (hostId: string) => Promise<void>
  saveHost: (host: HostProfile) => Promise<void>
  updateLastGood: (hostId: string, endpoint: string) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileEndpointSupervisor {
  private host: HostProfile
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private stickyLastGoodEligible = true
  private readonly reconnectPolicy = new MobileEndpointReconnectPolicy()
  private readonly timers: MobileEndpointSupervisorTimers
  private readonly relayPersistence: MobileRelayHostPersistence
  private readonly credentialRotation: MobileRelayCredentialRotationController
  private readonly bundleLoader: MobileRelayCredentialBundleLoader
  private readonly relayRouteAttempt: MobileRelayOrderedRouteAttempt
  private unsubscribeState: (() => void) | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.host = host
    this.timers = new MobileEndpointSupervisorTimers(dependencies.setTimer, dependencies.clearTimer)
    this.relayPersistence = new MobileRelayHostPersistence(
      dependencies.writeBundle,
      dependencies.deleteBundle,
      dependencies.saveHost,
      dependencies.randomBytes,
      dependencies.setTimer,
      dependencies.clearTimer
    )
    this.bundleLoader = new MobileRelayCredentialBundleLoader(
      dependencies.readBundle,
      dependencies.setTimer,
      dependencies.clearTimer
    )
    this.relayRouteAttempt = new MobileRelayOrderedRouteAttempt(
      logical,
      this.bundleLoader,
      this.relayPersistence,
      this.timers,
      () => this.host,
      (host) => {
        this.host = host
      },
      () => !this.stopped && this.foreground,
      (url) => this.recordLastGood(url),
      () => void this.reconnectInOrder(true),
      dependencies
    )
    this.credentialRotation = new MobileRelayCredentialRotationController(
      logical,
      this.relayPersistence,
      () => this.host,
      () => this.bundleLoader.current(),
      (result) => {
        this.host = result.host
        this.bundleLoader.replace(result.bundle)
      },
      () => !this.stopped && this.foreground,
      dependencies.now
    )
  }

  async start(): Promise<void> {
    if (this.host.relay) {
      this.bundleLoader.start(this.host.id, () => {
        if (
          !this.stopped &&
          this.logical.getState() === 'connected' &&
          this.logical.getActivePath() !== 'relay'
        ) {
          void this.credentialRotation.rotateIfNeeded()
        }
      })
    }
    if (this.stopped) {
      return
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (this.reconnectPolicy.isPublishingState) {
        return
      }
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.credentialRotation.rotateIfNeeded()
        }
      } else if (state === 'reconnecting' || state === 'disconnected') {
        void this.reconnectInOrder()
      }
    })
    if (this.logical.getState() === 'connected') {
      if (this.logical.getActivePath() !== 'relay') {
        await this.credentialRotation.rotateIfNeeded()
      }
      return
    }
    if (this.logical.getState() !== 'auth-failed') {
      await this.reconnectInOrder()
    }
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (!foreground) {
      this.timers.clearRetry()
      if (this.logical.getActivePath() === 'relay') {
        this.logical.suspendActiveSession()
      }
      return
    }
    this.reconnectPolicy.reset()
    if (this.logical.getState() !== 'connected' && this.logical.getState() !== 'auth-failed') {
      void this.reconnectInOrder()
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.timers.clearAll()
  }

  private async reconnectInOrder(forceReplacement = false): Promise<void> {
    if (
      this.stopped ||
      !this.foreground ||
      this.operationInFlight ||
      this.logical.getState() === 'auth-failed' ||
      (!forceReplacement && this.logical.getState() === 'connected')
    ) {
      return
    }
    this.timers.clearRetry()
    this.operationInFlight = true
    if (!forceReplacement) {
      this.reconnectPolicy.publishPassStart(this.logical)
    }
    const passDeadline = this.dependencies.now() + RECONNECT_PASS_TIMEOUT_MS
    try {
      const routes = orderedHostAccessRoutes(this.host, this.stickyLastGoodEligible)
      for (const [index, route] of routes.entries()) {
        if (this.stopped || !this.foreground) {
          return
        }
        // Why: deadline exhaustion must reach retry scheduling instead of parking forever.
        if (this.dependencies.now() >= passDeadline) {
          break
        }
        if (await this.tryRoute(route, passDeadline)) {
          if (this.logical.getState() === 'connected') {
            this.stickyLastGoodEligible = true
          }
          this.reconnectPolicy.reset()
          return
        }
        if (index === 0 && route.url === this.host.lastGoodEndpoint) {
          // Why: one dead sticky hint must not tax every retry pass; configured
          // user order resumes until another route authenticates successfully.
          this.stickyLastGoodEligible = false
        }
      }
    } finally {
      this.operationInFlight = false
    }
    if (this.stopped || !this.foreground) {
      return
    }
    const replacingLiveSession = forceReplacement && this.logical.getState() === 'connected'
    const delay = replacingLiveSession
      ? this.reconnectPolicy.recordReplacementFailure()
      : this.reconnectPolicy.recordPassFailure(this.logical)
    this.timers.scheduleRetry(
      delay,
      () => void this.reconnectInOrder(forceReplacement && this.logical.getState() === 'connected')
    )
  }

  private async tryRoute(route: MobileAccessEndpoint, passDeadline: number): Promise<boolean> {
    const routeDeadline = Math.min(passDeadline, this.dependencies.now() + ROUTE_AUTH_TIMEOUT_MS)
    if (route.kind === 'relay') {
      return this.relayRouteAttempt.try(routeDeadline)
    }
    let session: RpcClient
    try {
      session = this.dependencies.openDirect(route.url)
    } catch {
      return false
    }
    try {
      await this.logical.migrateTo(
        session,
        directPathForEndpoint(this.host, route.url),
        remainingRouteMs(routeDeadline, this.dependencies.now)
      )
      this.recordLastGood(route.url)
      this.timers.clearAll()
      void this.credentialRotation.rotateIfNeeded()
      return true
    } catch (error) {
      session.close()
      // Why: pinned-E2EE auth failure is host-scoped, so other IPs cannot repair it.
      if (error instanceof LogicalClientAuthenticationError) {
        this.logical.publishRouteOwnerState('auth-failed')
        return true
      }
      return false
    }
  }

  private recordLastGood(url: string): void {
    this.host = { ...this.host, lastGoodEndpoint: url }
    // Why: last-good is a reconnect hint; persistence cannot hold or tear down
    // an already authenticated route.
    void this.dependencies.updateLastGood(this.host.id, url).catch(() => {})
  }
}
