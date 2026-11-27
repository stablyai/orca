import type { MobileEndpointSupervisorDependencies } from '../connection/mobile-endpoint-supervisor-contract'
import {
  dialRelayThroughDirectorFallback,
  RelayDialAbortedError,
  toError
} from './mobile-relay-director-fallback'
import { RelayHostOfflineStreak } from './relay-host-offline-streak'
import { RelayDirectorHttpError, RelayResolveTimeoutBudget } from './mobile-relay-resume-director'
import { encodeBase64Url } from '../encryption/mobile-session-id-encoding'
import { persistResumeConfirmation } from './mobile-relay-credential-rotation'
import { isExplicitCredentialRejection } from './relay-credential-eligibility'
import { relayHostReachabilityForFailure } from './relay-host-reachability-latch'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from '../connection/stable-logical-rpc-client'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import { RELAY_HOST_CLOSE_REASON } from '../../../../src/shared/remote-runtime/relay/relay-host-close-reason'

function isDirectorRefusal(error: Error | null): boolean {
  return error instanceof RelayDirectorHttpError && error.status === 401
}

type EstablishResult = { ok: true } | { ok: false; error: Error }

function directWon(logical: StableLogicalRpcClient): boolean {
  return logical.getActivePath() !== 'relay' && logical.getState() === 'connected'
}

// Own candidate relays through cell resolution, logical migration and best-effort resume bookkeeping.
export class MobileRelaySessionEstablisher {
  private relay: MobileRelayEndpoint
  private readonly hostOfflineStreak: RelayHostOfflineStreak
  private readonly resolveTimeout = new RelayResolveTimeoutBudget()
  private resolvedThisAttempt = false
  // A director 401 for an older token: the next attempt gives pending the director lookup, so a moved host's
  // pending can find its cell, while current stays eligible (it is retired only by pending's promotion).
  private pendingLookupNext = false

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
      recordMigration: () => void
      // Owns the stopped/disconnected guard so late bookkeeping cannot arm a stale timer.
      scheduleLease: (expiry: number | null) => void
      scheduleDirectProbe: () => void
      onBookkeepingError: (error: Error) => void
      onDialFailure: (error: Error) => void
    }
  ) {
    this.relay = args.relay
    this.hostOfflineStreak = new RelayHostOfflineStreak(() => args.logical.getLastConnectedAt())
  }

  async adoptRelay(relay: MobileRelayEndpoint): Promise<void> {
    // A stopped supervisor’s successor owns routing after removal/re-pairing.
    if (this.args.isStopped()) {
      return
    }
    await this.args.setRelayRouting(this.args.hostId, relay)
    this.relay = relay
  }

  // Try the next credential only after the relay refuses one; pending comes last (relayDialCandidates).
  async dialEligible(
    credentials: { token: string; version: number }[]
  ): Promise<
    | { outcome: 'established' }
    | { outcome: 'aborted' }
    | { outcome: 'failed'; error: Error | null; evidence?: Error; unconfirmed: boolean }
  > {
    let lastError: Error | null = null
    let refusal: Error | undefined
    let directorRefused = false
    const pendingToken = this.args.bundle()?.pending?.token
    const pendingFirst = this.pendingLookupNext
    this.pendingLookupNext = false
    const ordered = pendingFirst
      ? [
          ...credentials.filter((credential) => credential.token === pendingToken),
          ...credentials.filter((credential) => credential.token !== pendingToken)
        ]
      : credentials
    this.resolvedThisAttempt = false
    let lastDialedPending = false
    for (const credential of ordered) {
      // After a director 401 the rest only redial the cell that sent us there, which can know only the newer
      // pending install; redialing current or grace would just repeat its wrong-assignment answer.
      if (directorRefused && credential.token !== pendingToken) {
        continue
      }
      lastDialedPending = credential.token === pendingToken
      // The director admits one resolve per host per window, so after any lookup the rest only dial the cell.
      const result = await this.dial(credential, !this.resolvedThisAttempt)
      if (result.ok) {
        return { outcome: 'established' }
      }
      if (result.error instanceof RelayDialAbortedError) {
        return { outcome: 'aborted' }
      }
      lastError = result.error
      this.args.onDialFailure(result.error)
      if (isExplicitCredentialRejection(result.error)) {
        // Why: a rejected version stays invalid; retry only the later credentials. Pending is the exception: its
        // install may commit after this refusal, so it stays dialable and only a confirmed version is retired.
        if (credential.token !== pendingToken) {
          this.args.controller.recordRejectedCredential(credential.version)
        }
        refusal ??= result.error
        continue
      }
      // A director 401 can be stale (it reads a store an edge-hosted host may have outgrown), so it condemns
      // nothing: try pending at this cell now, and give pending the lookup on the next attempt.
      if (!isDirectorRefusal(result.error)) {
        break
      }
      this.pendingLookupNext ||= pendingToken !== undefined && credential.token !== pendingToken
      directorRefused = true
    }
    return {
      outcome: 'failed',
      error: lastError,
      // A verdict-less last failure (say, a director 503 for pending) must not reopen the refused verdict.
      evidence: relayHostReachabilityForFailure(lastError) === 'connecting' ? refusal : undefined,
      unconfirmed: lastDialedPending
    }
  }

  dial(
    credential: { token: string; version: number },
    canResolve = true
  ): Promise<EstablishResult> {
    return dialRelayThroughDirectorFallback({
      canResolve,
      resumeToken: credential.token,
      hostOfflineStreak: this.hostOfflineStreak,
      relay: () => this.relay,
      dial: () => this.establish(credential),
      resolveRelay: (input) => this.resolveRelay(input),
      persistResolvedRelay: (resolved) => this.adoptRelay(resolved)
    })
  }

  private async resolveRelay(input: {
    relay: MobileRelayEndpoint
    resumeToken: string
  }): Promise<MobileRelayEndpoint> {
    this.resolvedThisAttempt = true
    try {
      const resolved = await this.args.resolveRelay({
        ...input,
        timeoutMs: this.resolveTimeout.timeoutMs
      })
      this.resolveTimeout.succeeded()
      return resolved
    } catch (error) {
      this.resolveTimeout.failed(error)
      throw error
    }
  }

  private async establish(credential: {
    token: string
    version: number
  }): Promise<EstablishResult> {
    const { args } = this
    const bundle = args.bundle()
    // Why: director resolution and grace fallback can finish after background/stop or a direct win.
    if (!args.isActive() || !bundle || directWon(args.logical)) {
      return { ok: false, error: new RelayDialAbortedError() }
    }
    let session: ReturnType<typeof args.openRelay>
    try {
      session = args.openRelay(
        this.relay,
        credential,
        `confirm-${encodeBase64Url(args.randomBytes(16))}`,
        // Read the controller latch because close reasons can arrive after the dial failed; only connection clears it.
        (reason) => {
          if (reason === RELAY_HOST_CLOSE_REASON.SIGNED_OUT) {
            args.controller.assertHostReachability('signed-out')
          }
        }
      )
    } catch (error) {
      // Why: a socket constructor throw is a failed dial; it must book a retry, not reject the recovery.
      return { ok: false, error: toError(error) }
    }
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
      if (applied.bundle.current.version !== bundle.current.version) {
        // Pending was promoted; the old versions' refusals would force a needless direct rotation.
        args.controller.completeCredentialRefresh()
      }
      args.scheduleLease(applied.leaseExpiry)
    } catch (error) {
      // Report post-migration bookkeeping separately; counting it as dial failure could suspend the healthy session.
      args.onBookkeepingError(toError(error))
    }
    args.scheduleDirectProbe()
    return { ok: true }
  }
}
