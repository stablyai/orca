import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import {
  persistRelayHost,
  suspendRelayIfStillConnected
} from './mobile-endpoint-supervisor-support'
import { selectDialableRelayCredentials } from './mobile-relay-credential-selection'
import { createRelayRecoveryLog, type RelayRecoveryLog } from './mobile-relay-recovery-log'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileRelayCredentialRefresh } from './mobile-relay-credential-refresh'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import { MobileRelayDirectGraceTimer } from './mobile-relay-direct-grace-timer'
import { MobileRelaySessionEstablisher } from './mobile-relay-session-establisher'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason, HostProfile } from './types'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private foreground = true
  private operationInFlight = false
  private pendingReplace = false
  private readonly nudgeRouter: MobileEndpointNudgeRouter
  private relayRotationPending = false
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer
  private readonly logRelay: RelayRecoveryLog
  private readonly directProbe: DirectReturnProbe
  private readonly directGrace: MobileRelayDirectGraceTimer
  private readonly sessionEstablisher: MobileRelaySessionEstablisher
  private readonly credentialRefresh: MobileRelayCredentialRefresh

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private host: HostProfile,
    private readonly dependencies: MobileEndpointSupervisorDependencies
  ) {
    this.hysteresis = new MobileEndpointHysteresis(dependencies.now(), {
      directSuccessesRequired: 3,
      directObservationMs: DIRECT_OBSERVATION_MS,
      failureCooldownMs: FAILURE_COOLDOWN_MS,
      minimumDwellMs: MINIMUM_DWELL_MS
    })
    this.logRelay = createRelayRecoveryLog(dependencies.now, dependencies.onLog)
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.credentialRefresh = new MobileRelayCredentialRefresh({
      logical,
      controller: this.relayReconnect,
      dependencies,
      bundle: () => this.bundle,
      host: () => this.host,
      adoptBundle: (bundle) => {
        this.bundle = bundle
      },
      adoptHost: (host) => {
        this.host = host
        this.dependencies.onHostUpdated?.(host)
      },
      isStopped: () => this.stopped,
      isForeground: () => this.foreground,
      recoverRelay: () => void this.recoverRelay()
    })
    this.nudgeRouter = new MobileEndpointNudgeRouter({
      logical,
      controller: this.relayReconnect,
      now: dependencies.now,
      isStopped: () => this.stopped,
      isForeground: () => this.foreground,
      setForeground: (foreground) => this.setForeground(foreground),
      replaceRelay: () => void this.recoverRelay(true, true),
      recoverAfterDeadProbe: (detail) => {
        this.logRelay('relay probe failed; recovering', detail)
        suspendRelayIfStillConnected(this.relayReconnect, this.logical)
        void this.recoverRelay()
      },
      scheduleDirectProbe: () => this.directProbe.schedule(0)
    })
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
    // Why: the race owns recovery exactly like a network-change replacement — its
    // failure must book the shared cooldown. recoverRelay's own guards already
    // cover stopped/background/no-relay, so the timer needs no scope check.
    this.directGrace = new MobileRelayDirectGraceTimer(dependencies, logical, () => {
      void this.recoverRelay(true, true)
    })
    this.sessionEstablisher = new MobileRelaySessionEstablisher({
      logical,
      controller: this.relayReconnect,
      openRelay: dependencies.openRelay,
      randomBytes: dependencies.randomBytes,
      writeBundle: dependencies.writeBundle,
      isActive: () => !this.stopped && this.foreground,
      isForeground: () => this.foreground,
      relay: () => this.host.relay,
      resolveRelay: dependencies.resolveRelay,
      persistResolvedRelay: async (resolved) => {
        if (this.stopped) {
          return
        }
        this.host = await persistRelayHost(this.host, resolved, dependencies.saveHost)
        if (!this.stopped) {
          this.dependencies.onHostUpdated?.(this.host)
        }
      },
      bundle: () => this.bundle,
      adoptBundle: (bundle) => {
        this.bundle = bundle
      },
      recordMigration: () => {
        this.relayRotationPending = false
        this.hysteresis.recordMigration(dependencies.now())
        this.logRelay('runtime channel migrated to relay')
      },
      scheduleLease: (expiry) =>
        this.leaseRotation.scheduleFromLease(this.stopped || !this.foreground ? null : expiry),
      scheduleDirectProbe: () => this.directProbe.schedule(),
      onBookkeepingError: (error) =>
        this.logRelay('relay bookkeeping failed after migration', error.message.slice(0, 80)),
      onDialFailure: (error) =>
        this.logRelay('relay dial failed', `${error.name}: ${String(error.message).slice(0, 80)}`)
    })
    this.directProbe = new DirectReturnProbe(dependencies, {
      hysteresis: this.hysteresis,
      host: () => this.host,
      canSchedule: () =>
        !this.stopped && this.foreground && this.logical.getActivePath() === 'relay',
      canAttempt: () => !this.stopped && this.foreground && !this.operationInFlight,
      beginOperation: () => {
        this.operationInFlight = true
      },
      migrate: (client, path) => this.logical.migrateTo(client, path),
      onDirectMigrated: async () => {
        this.leaseRotation.clear()
        this.relayRotationPending = false
        await this.credentialRefresh.run(this.relayReconnect.resetForDirectConnection())
      },
      afterProbe: () => {
        this.operationInFlight = false
        if (
          this.pendingReplace ||
          this.relayRotationPending ||
          this.logical.getState() !== 'connected'
        ) {
          void this.recoverRelay(this.relayRotationPending)
        }
      }
    })
  }

  async start(): Promise<void> {
    this.bundle = await this.dependencies.readBundle(this.host.id).catch(() => null)
    if (this.stopped || !this.host.relay) {
      return
    }
    if (!this.bundle) {
      // Why: a Keychain race at open must not kill relay recovery for the whole
      // process lifetime; each recovery attempt re-reads the durable bundle.
      this.logRelay('credential bundle unavailable at start; recovery will re-read')
    }
    this.unsubscribeState = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        this.directGrace.clear()
        if (this.logical.getActivePath() !== 'relay') {
          void this.credentialRefresh.run(this.relayReconnect.resetForDirectConnection())
        }
        this.directProbe.schedule()
      } else {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        this.relayReconnect.handleStateFailure(this.logical, state)
      }
    })
    if (this.relayReconnect.needsRecovery(this.logical.getState())) {
      // Why: the first direct dial can fail while encrypted relay credentials
      // are still loading, before the supervisor subscribes to state changes.
      await this.recoverRelay()
    } else {
      this.directProbe.schedule()
      this.directGrace.arm()
    }
  }

  setForeground(foreground: boolean): void {
    const wasForeground = this.foreground
    this.foreground = foreground
    if (foreground) {
      this.relayReconnect.handleForeground(this.logical, wasForeground)
      this.directProbe.schedule(0)
      this.directGrace.arm()
    } else {
      // Why: background phones must not hold billed relay data splices.
      this.relayReconnect.suspendActiveRelay(this.logical)
      this.directProbe.clear()
      this.relayReconnect.clear()
      this.leaseRotation.clear()
      this.directGrace.clear()
    }
  }

  nudge(reason: ForegroundNudgeReason): void {
    this.nudgeRouter.nudge(reason)
  }

  stop(): void {
    this.stopped = true
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.directProbe.clear()
    this.relayReconnect.clear()
    this.leaseRotation.clear()
    this.directGrace.clear()
  }

  // forceReplacement: dial past the "direct still looks live" guard — a lease
  // rotation, a network-change replacement, or the happy-eyeballs grace race.
  // ownsRecovery: this dial is the connection's only hope, so a failure books the
  // shared cooldown and any session left stale-'connected' by a half-open socket
  // comes down; lease rotation clears it because armRetry owns its own retry.
  private async recoverRelay(forceReplacement = false, ownsRecovery = false): Promise<void> {
    if (this.stopped || !this.foreground || !this.host.relay) {
      return
    }
    if (this.operationInFlight) {
      // Why: a 12s direct probe can own the mutex when a network handoff lands;
      // afterProbe replays the queued replacement so the signal is never lost.
      this.pendingReplace ||= forceReplacement && ownsRecovery
      return
    }
    if (this.pendingReplace) {
      this.pendingReplace = false
      forceReplacement = true
      ownsRecovery = true
    }
    // Why: connecting/handshaking is live direct progress; an unforced relay dial
    // would race it before the grace timer has given direct its head start.
    if (!forceReplacement && !this.relayReconnect.needsRecovery(this.logical.getState())) {
      return
    }
    // Why: revival and lease timers can overlap resume failures; one shared cooldown
    // prevents PEER_DROPPED/LIMIT_EXCEEDED reconnect churn.
    if (this.relayReconnect.shouldDefer()) {
      if (ownsRecovery) {
        // Why: never tear down a session no dial has disproven — the intent stays
        // queued so the armed retry runs forced once the cooldown lapses.
        this.pendingReplace = true
      }
      this.logRelay('recovery deferred by cooldown or gate')
      return
    }
    this.operationInFlight = true
    let lastError: Error | null = null
    let retryAfterOperation = false
    try {
      const selection = await selectDialableRelayCredentials({
        bundle: this.bundle,
        controller: this.relayReconnect,
        readBundle: () => this.dependencies.readBundle(this.host.id),
        onAdoptedFresherBundle: () => this.logRelay('adopted fresher durable credential bundle')
      })
      this.bundle = selection.bundle
      if (selection.credentials.length === 0) {
        // Why: "expired" vs "missing" separates a sleep-past-expiry phone
        // (needs re-pair or LAN) from a Keychain failure in field reports.
        this.logRelay(
          selection.bundle
            ? 'relay credential expired or rejected; slow reprobe armed'
            : 'no relay credential bundle; slow reprobe armed'
        )
        this.relayReconnect.armCredentialReprobe()
        if (ownsRecovery) {
          // Why: no dial happened — keep the session and the intent; the reprobe
          // runs forced and replaces make-before-break once a credential exists.
          this.pendingReplace = true
        }
        return
      }
      const dialed = await this.sessionEstablisher.dialEligible(selection.credentials)
      if (dialed.outcome === 'established') {
        // Why: a fresh socket satisfies any replacement intent queued mid-dial.
        this.pendingReplace = false
        retryAfterOperation = this.logical.getState() !== 'connected'
        return
      }
      if (dialed.outcome === 'aborted') {
        // Why: direct won the race or the supervisor went inactive — not a
        // failure; booking backoff would delay the next genuine recovery.
        return
      }
      lastError = dialed.error
      // Why: cleanup may happen while a relay dial is awaiting the network;
      // record its outcome without recreating a foreground retry timer.
      const scheduleRetry = (!forceReplacement || ownsRecovery) && this.foreground && !this.stopped
      this.relayReconnect.registerFailure(lastError, scheduleRetry)
      if (ownsRecovery) {
        suspendRelayIfStillConnected(this.relayReconnect, this.logical)
      }
    } finally {
      this.operationInFlight = false
      if (forceReplacement && this.relayRotationPending && !this.stopped && this.foreground) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      // Why: the active relay can drop while migration follow-up still owns the mutex.
      if (retryAfterOperation && !this.stopped && this.foreground) {
        void this.recoverRelay()
      }
    }
  }
}
