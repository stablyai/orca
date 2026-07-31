import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  isDirectorResolutionFailure,
  remainingRouteMs,
  withEndpointRouteDeadline
} from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayCredentialBundleLoader } from './mobile-relay-credential-bundle-loader'
import type { MobileRelayHostPersistence } from './mobile-relay-host-persistence'
import type { MobileRelayRpcSession } from './mobile-relay-rpc-session'
import {
  isFinalRelayFailure,
  keepMobileRelayRouteActive,
  openMobileRelayRoute
} from './mobile-relay-route-connection'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'
import type { MobileEndpointSupervisorTimers } from './mobile-endpoint-supervisor-timers'
import { relayWebSocketUrl } from './mobile-access-route-order'

type Dependencies = {
  openRelay: (
    relay: MobileRelayEndpoint,
    credential: { token: string; version: number },
    confirmReqId: string
  ) => MobileRelayRpcSession
  resolveRelay: (args: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }) => Promise<MobileRelayEndpoint>
  writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
  now: () => number
  randomBytes: (length: number) => Uint8Array
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}

export class MobileRelayOrderedRouteAttempt {
  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly bundles: MobileRelayCredentialBundleLoader,
    private readonly persistence: MobileRelayHostPersistence,
    private readonly timers: MobileEndpointSupervisorTimers,
    private readonly getHost: () => HostProfile,
    private readonly setHost: (host: HostProfile) => void,
    private readonly isActive: () => boolean,
    private readonly recordLastGood: (url: string) => void,
    private readonly reconnect: () => void,
    private readonly dependencies: Dependencies
  ) {}

  async try(routeDeadline: number): Promise<boolean> {
    let host = this.getHost()
    if (!host.relay) {
      return false
    }
    let bundle = this.bundles.current()
    if (!bundle) {
      try {
        bundle = await this.bundles.wait(remainingRouteMs(routeDeadline, this.dependencies.now))
      } catch {
        return false
      }
    }
    if (!bundle) {
      return false
    }
    const credentials = [bundle.current, bundle.grace].filter(
      (credential): credential is NonNullable<typeof credential> =>
        Boolean(credential && credential.expiresAt > this.dependencies.now())
    )
    for (const credential of credentials) {
      if (this.dependencies.now() >= routeDeadline) {
        return false
      }
      const first = await this.open(credential, routeDeadline)
      if (first.ok || isFinalRelayFailure(first, this.isActive())) {
        return true
      }
      host = this.getHost()
      if (!isDirectorResolutionFailure(first.error) || !host.relay) {
        continue
      }
      try {
        const resolved = await withEndpointRouteDeadline({
          promise: this.dependencies.resolveRelay({
            relay: host.relay,
            resumeToken: credential.token
          }),
          timeoutMs: remainingRouteMs(routeDeadline, this.dependencies.now),
          setTimer: this.dependencies.setTimer,
          clearTimer: this.dependencies.clearTimer
        })
        if (!this.isActive()) {
          return true
        }
        host = await this.persistence.persist(
          host,
          resolved,
          remainingRouteMs(routeDeadline, this.dependencies.now)
        )
        this.setHost(host)
        const retried = await this.open(credential, routeDeadline)
        if (retried.ok || isFinalRelayFailure(retried, this.isActive())) {
          return true
        }
      } catch {}
    }
    return false
  }

  private async open(
    credential: { token: string; version: number },
    routeDeadline: number
  ): ReturnType<typeof openMobileRelayRoute> {
    const host = this.getHost()
    const bundle = this.bundles.current()
    if (!host.relay || !bundle) {
      return { ok: false, error: new Error('relay state missing'), authenticationFailed: false }
    }
    const result = await openMobileRelayRoute({
      relay: host.relay,
      bundle,
      credential,
      timeoutMs: remainingRouteMs(routeDeadline, this.dependencies.now),
      logical: this.logical,
      openRelay: this.dependencies.openRelay,
      writeBundle: this.dependencies.writeBundle,
      randomBytes: this.dependencies.randomBytes,
      shouldKeepActive: this.isActive
    })
    if (!result.ok) {
      if (result.authenticationFailed) {
        this.logical.publishRouteOwnerState('auth-failed')
      }
      return result
    }
    this.bundles.replace(result.bundle)
    return keepMobileRelayRouteActive({
      result,
      logical: this.logical,
      isStopped: () => !this.isActive(),
      isForeground: this.isActive,
      recordLastGood: () => this.recordLastGood(relayWebSocketUrl(host.relay!)),
      scheduleLease: (session) =>
        this.timers.scheduleLease(session, this.dependencies.now, this.reconnect)
    })
  }
}
