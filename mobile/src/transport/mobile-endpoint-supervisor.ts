import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  isDirectorResolutionFailure,
  persistRelayHost,
  withEndpointRouteDeadline
} from './mobile-endpoint-supervisor-support'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import { orderedHostAccessRoutes, relayWebSocketUrl } from './mobile-access-route-order'
import { openMobileRelayRoute } from './mobile-relay-route-connection'
import { directPathForEndpoint } from './mobile-direct-endpoint-probe'
import type { RpcClient } from './rpc-client'
import {
  LogicalClientAuthenticationError,
  type StableLogicalRpcClient
} from './stable-logical-rpc-client'
import type { HostProfile, MobileAccessEndpoint } from './types'

const ROUTE_AUTH_TIMEOUT_MS = 3_500
const RECONNECT_PASS_TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 2_000
const LEASE_ROTATION_MARGIN_MS = 30_000

type RelayRouteAttempt = { ok: true } | { ok: false; error: Error; authenticationFailed: boolean }

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
  saveHost: (host: HostProfile) => Promise<void>
  updateLastGood: (hostId: string, endpoint: string) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileEndpointSupervisor {
  private host: HostProfile
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private rotationInFlight = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private leaseTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeState: (() => void) | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.host = host
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.host.relay) {
      return
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        if (this.logical.getActivePath() !== 'relay') {
          void this.rotateCredentialIfNeeded()
        }
      } else if (state === 'reconnecting' || state === 'disconnected') {
        void this.reconnectInOrder()
      }
    })
    const state = this.logical.getState()
    if (state === 'connected') {
      if (this.logical.getActivePath() !== 'relay') {
        await this.rotateCredentialIfNeeded()
      }
      return
    }
    if (state === 'auth-failed') {
      return
    }
    await this.reconnectInOrder()
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (!foreground) {
      this.clearRetryTimer()
      if (this.logical.getActivePath() === 'relay') {
        this.logical.suspendActiveSession()
      }
      return
    }
    if (this.logical.getState() !== 'connected' && this.logical.getState() !== 'auth-failed') {
      void this.reconnectInOrder()
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.clearRetryTimer()
    this.clearLeaseTimer()
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
    this.clearRetryTimer()
    this.operationInFlight = true
    const passDeadline = this.dependencies.now() + RECONNECT_PASS_TIMEOUT_MS
    try {
      for (const route of orderedHostAccessRoutes(this.host)) {
        if (this.stopped || !this.foreground || this.dependencies.now() >= passDeadline) {
          return
        }
        if (await this.tryRoute(route, passDeadline)) {
          return
        }
      }
    } finally {
      this.operationInFlight = false
    }
    this.retryTimer = this.dependencies.setTimer(() => {
      this.retryTimer = null
      void this.reconnectInOrder()
    }, RETRY_DELAY_MS)
  }

  private async tryRoute(route: MobileAccessEndpoint, passDeadline: number): Promise<boolean> {
    const routeDeadline = Math.min(passDeadline, this.dependencies.now() + ROUTE_AUTH_TIMEOUT_MS)
    if (route.kind === 'relay') {
      return this.tryRelayRoute(routeDeadline)
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
        this.remainingMs(routeDeadline)
      )
      await this.recordLastGood(route.url)
      this.clearLeaseTimer()
      void this.rotateCredentialIfNeeded()
      return true
    } catch (error) {
      session.close()
      // Why: auth-failed is host-scoped after pinned E2EE, so another address
      // cannot repair it and would only multiply credential guesses.
      if (error instanceof LogicalClientAuthenticationError) {
        this.logical.publishRouteOwnerState('auth-failed')
        return true
      }
      return false
    }
  }

  private async tryRelayRoute(routeDeadline: number): Promise<boolean> {
    if (!this.bundle || !this.host.relay) {
      return false
    }
    const credentials = [this.bundle.current, this.bundle.grace].filter(
      (credential): credential is NonNullable<typeof credential> =>
        Boolean(credential && credential.expiresAt > this.dependencies.now())
    )
    for (const credential of credentials) {
      if (this.dependencies.now() >= routeDeadline) {
        return false
      }
      const first = await this.openAndMigrateRelay(credential, routeDeadline)
      if (first.ok) {
        return true
      }
      if (first.authenticationFailed) {
        return true
      }
      if (!isDirectorResolutionFailure(first.error) || !this.host.relay) {
        continue
      }
      try {
        const resolved = await withEndpointRouteDeadline({
          promise: this.dependencies.resolveRelay({
            relay: this.host.relay,
            resumeToken: credential.token
          }),
          timeoutMs: this.remainingMs(routeDeadline),
          setTimer: this.dependencies.setTimer,
          clearTimer: this.dependencies.clearTimer
        })
        this.host = await persistRelayHost(this.host, resolved, this.dependencies.saveHost)
        const retried = await this.openAndMigrateRelay(credential, routeDeadline)
        if (retried.ok || retried.authenticationFailed) {
          return true
        }
      } catch {}
    }
    return false
  }

  private async openAndMigrateRelay(
    credential: { token: string; version: number },
    routeDeadline: number
  ): Promise<RelayRouteAttempt> {
    if (!this.host.relay || !this.bundle) {
      return {
        ok: false,
        error: new Error('relay state missing'),
        authenticationFailed: false
      }
    }
    const result = await openMobileRelayRoute({
      relay: this.host.relay,
      bundle: this.bundle,
      credential,
      timeoutMs: this.remainingMs(routeDeadline),
      logical: this.logical,
      openRelay: this.dependencies.openRelay,
      writeBundle: this.dependencies.writeBundle,
      randomBytes: this.dependencies.randomBytes
    })
    if (result.ok) {
      this.bundle = result.bundle
      await this.recordLastGood(relayWebSocketUrl(this.host.relay))
      this.scheduleLeaseRotation(result.session)
      return { ok: true }
    }
    if (result.authenticationFailed) {
      this.logical.publishRouteOwnerState('auth-failed')
    }
    return result
  }

  private async recordLastGood(url: string): Promise<void> {
    this.host = { ...this.host, lastGoodEndpoint: url }
    await this.dependencies.updateLastGood(this.host.id, url).catch(() => {})
  }

  private async rotateCredentialIfNeeded(): Promise<void> {
    if (
      this.stopped ||
      this.rotationInFlight ||
      !this.bundle ||
      this.logical.getActivePath() === 'relay' ||
      !mobileRelayCredentialNeedsRotation(this.bundle, this.dependencies.now())
    ) {
      return
    }
    this.rotationInFlight = true
    try {
      const result = await rotateMobileRelayCredential({
        client: this.logical,
        bundle: this.bundle,
        writeBundle: this.dependencies.writeBundle,
        randomBytes: this.dependencies.randomBytes
      })
      this.bundle = result.bundle
      this.host = await persistRelayHost(this.host, result.relay, this.dependencies.saveHost)
    } catch {
      // Pending rotation state stays durable for the next authenticated direct route.
    } finally {
      this.rotationInFlight = false
    }
  }

  private scheduleLeaseRotation(session: MobileRelayRpcSession): void {
    this.clearLeaseTimer()
    const deadline = session.getLeaseExpiresAt()
    if (!deadline) {
      return
    }
    const delay = Math.max(1_000, deadline - this.dependencies.now() - LEASE_ROTATION_MARGIN_MS)
    this.leaseTimer = this.dependencies.setTimer(() => {
      this.leaseTimer = null
      void this.reconnectInOrder(true)
    }, delay)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      this.dependencies.clearTimer(this.retryTimer)
      this.retryTimer = null
    }
  }

  private clearLeaseTimer(): void {
    if (this.leaseTimer) {
      this.dependencies.clearTimer(this.leaseTimer)
      this.leaseTimer = null
    }
  }

  private remainingMs(deadline: number): number {
    return Math.max(1, deadline - this.dependencies.now())
  }
}
