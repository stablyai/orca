import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import {
  dialRelayThroughDirectorFallback,
  encodeBase64Url,
  RelayDialAbortedError,
  toError
} from './mobile-endpoint-supervisor-support'
import { persistResumeConfirmation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { HostProfile } from './types'

type EstablishResult = { ok: true } | { ok: false; error: Error }

function directWon(logical: StableLogicalRpcClient): boolean {
  return logical.getActivePath() !== 'relay' && logical.getState() === 'connected'
}

// Turns one relay credential into the active runtime session: resolve the cell
// assignment if the director rejects the cached one, open the cell socket,
// migrate the logical client onto it, then persist the resume confirmation and
// re-arm the supervisor's timers.
export class MobileRelaySessionEstablisher {
  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      openRelay: MobileEndpointSupervisorDependencies['openRelay']
      randomBytes: (length: number) => Uint8Array
      writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
      isActive: () => boolean
      isForeground: () => boolean
      relay: () => HostProfile['relay']
      resolveRelay: MobileEndpointSupervisorDependencies['resolveRelay']
      persistResolvedRelay: (resolved: MobileRelayEndpoint) => Promise<void>
      bundle: () => MobileRelayCredentialBundle | null
      adoptBundle: (bundle: MobileRelayCredentialBundle) => void
      // Hysteresis stamp + rotation-pending clear + recovery log line.
      recordMigration: () => void
      // Owns the stopped/background null-out so a late resolve never re-arms a stale timer.
      scheduleLease: (expiry: number | null) => void
      scheduleDirectProbe: () => void
      onBookkeepingError: (error: Error) => void
      onDialFailure: (error: Error) => void
    }
  ) {}

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
      if (!this.args.controller.shouldTryGraceAfterRelayFailure(result.error)) {
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
      relay: this.args.relay,
      dial: () => this.establish(credential),
      resolveRelay: this.args.resolveRelay,
      persistResolvedRelay: this.args.persistResolvedRelay
    })
  }

  private async establish(credential: {
    token: string
    version: number
  }): Promise<EstablishResult> {
    const { args } = this
    const relay = args.relay()
    const bundle = args.bundle()
    // Why: director resolution and grace fallback can finish after background/stop.
    if (!args.isActive() || !relay || !bundle) {
      return { ok: false, error: new RelayDialAbortedError() }
    }
    const session = args.openRelay(
      relay,
      credential,
      `confirm-${encodeBase64Url(args.randomBytes(16))}`
    )
    try {
      // Why: if an authenticated non-relay session appears while this dial is in
      // flight (the grace race), withdraw instead of cutting over the winner.
      await args.logical.migrateTo(session, 'relay', undefined, () => directWon(args.logical))
    } catch (error) {
      if (directWon(args.logical)) {
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
