import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import {
  dialRelayThroughDirectorFallback,
  encodeBase64Url,
  RelayDialAbortedError,
  toError
} from './mobile-endpoint-supervisor-support'
import { persistResumeConfirmation } from './mobile-relay-credential-rotation'
import { relayFailureAllowsGraceRetry } from './relay-credential-eligibility'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { RELAY_HOST_CLOSE_REASON } from '../../../src/shared/relay-host-close-reason'

type EstablishResult = { ok: true } | { ok: false; error: Error }

function directWon(logical: StableLogicalRpcClient): boolean {
  return logical.getActivePath() !== 'relay' && logical.getState() === 'connected'
}

// Turns one relay credential into the active runtime session: resolve the cell
// assignment if the director rejects the cached one, open the cell socket,
// migrate the logical client onto it, then persist the resume confirmation and
// re-arm the supervisor's timers. Owns the relay it dials.
export class MobileRelaySessionEstablisher {
  private relay: MobileRelayEndpoint

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      openRelay: MobileEndpointSupervisorDependencies['openRelay']
      randomBytes: (length: number) => Uint8Array
      writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
      isActive: () => boolean
      isForeground: () => boolean
      isStopped: () => boolean
      hostId: string
      relay: MobileRelayEndpoint
      resolveRelay: MobileEndpointSupervisorDependencies['resolveRelay']
      setRelayRouting: MobileEndpointSupervisorDependencies['setRelayRouting']
      bundle: () => MobileRelayCredentialBundle | null
      adoptBundle: (bundle: MobileRelayCredentialBundle) => void
      // Hysteresis stamp + rotation-pending clear + recovery log line.
      recordMigration: () => void
      // Owns the stopped/disconnected guard so late bookkeeping cannot arm a stale timer.
      scheduleLease: (expiry: number | null) => void
      scheduleDirectProbe: () => void
      onBookkeepingError: (error: Error) => void
      onDialFailure: (error: Error) => void
    }
  ) {
    this.relay = args.relay
  }

  async adoptRelay(relay: MobileRelayEndpoint): Promise<void> {
    // Why: a stopped supervisor's host may be removed or re-paired; its successor owns routing.
    if (this.args.isStopped()) {
      return
    }
    await this.args.setRelayRouting(this.args.hostId, relay)
    this.relay = relay
  }

  // Tries each eligible credential until one establishes. Only a grace-repairable
  // failure (BAD_OUTER_CREDENTIAL) moves on to the next credential.
  async dialEligible(
    credentials: { token: string; version: number }[]
  ): Promise<
    { outcome: 'established' } | { outcome: 'aborted' } | { outcome: 'failed'; error: Error | null }
  > {
    let lastError: Error | null = null
    for (const credential of credentials) {
      const result = await this.dial(credential)
      if (result.ok) {
        return { outcome: 'established' }
      }
      if (result.error instanceof RelayDialAbortedError) {
        return { outcome: 'aborted' }
      }
      lastError = result.error
      this.args.onDialFailure(result.error)
      if (!relayFailureAllowsGraceRetry(result.error)) {
        break
      }
      // Why: a rejected version stays invalid; retry only the grace credential.
      this.args.controller.recordRejectedCredential(credential.version)
    }
    return { outcome: 'failed', error: lastError }
  }

  // One credential attempt: a director-class failure re-resolves the cell
  // assignment, persists it, and dials once more against the authoritative target.
  dial(credential: { token: string; version: number }): Promise<EstablishResult> {
    return dialRelayThroughDirectorFallback({
      resumeToken: credential.token,
      relay: () => this.relay,
      dial: () => this.establish(credential),
      resolveRelay: this.args.resolveRelay,
      persistResolvedRelay: (resolved) => this.adoptRelay(resolved)
    })
  }

  private async establish(credential: {
    token: string
    version: number
  }): Promise<EstablishResult> {
    const { args } = this
    const bundle = args.bundle()
    // Why: director resolution and grace fallback can finish after background/stop.
    if (!args.isActive() || !bundle) {
      return { ok: false, error: new RelayDialAbortedError() }
    }
    const session = args.openRelay(
      this.relay,
      credential,
      `confirm-${encodeBase64Url(args.randomBytes(16))}`,
      // Asserted on the controller's latch, not on the dial result: the close
      // that carries the reason can land after this dial has already reported
      // its failure. Only a connection retires it.
      (reason) => {
        if (reason === RELAY_HOST_CLOSE_REASON.SIGNED_OUT) {
          args.controller.assertHostReachability('signed-out')
        }
      }
    )
    try {
      // Why: backgrounding or a direct winner withdraws this dial before cutover.
      await args.logical.migrateTo(
        session,
        'relay',
        undefined,
        () => !args.isActive() || directWon(args.logical)
      )
    } catch (error) {
      if (!args.isActive() || directWon(args.logical)) {
        return { ok: false, error: new RelayDialAbortedError() }
      }
      return { ok: false, error: session.getFailure() ?? toError(error) }
    }
    args.controller.setActiveSession(session)
    if (!args.isForeground()) {
      args.controller.suspendActiveRelay(args.logical)
    }
    args.recordMigration()
    try {
      const applied = await persistResumeConfirmation({
        session,
        bundle,
        usedCredentialVersion: credential.version,
        writeBundle: args.writeBundle
      })
      args.adoptBundle(applied.bundle)
      args.scheduleLease(applied.leaseExpiry)
    } catch (error) {
      // Why: the session is live and registered — reporting bookkeeping as a dial
      // failure would book backoff against it and can suspend the healthy session.
      args.onBookkeepingError(toError(error))
    }
    args.scheduleDirectProbe()
    return { ok: true }
  }
}
