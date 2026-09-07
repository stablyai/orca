import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { DirectReturnProbe } from './mobile-direct-return-probe'
import { RelayReconnectController } from './mobile-relay-reconnect-controller'
import { RelayLeaseRotationTimer } from './mobile-relay-lease-rotation-timer'
import { MobileEndpointHysteresis } from './mobile-endpoint-hysteresis'
import {
  liveRelayLeaseExpiry,
  persistRelayHost,
  suspendRelayIfStillConnected
} from './mobile-endpoint-supervisor-support'
import { selectDialableRelayCredentials } from './mobile-relay-credential-selection'
import { createRelayRecoveryLog, type RelayRecoveryLog } from './mobile-relay-recovery-log'
import { MobileRelayCredentialRefresh } from './mobile-relay-credential-refresh'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { MobileEndpointNudgeRouter } from './mobile-endpoint-nudge-router'
import { RelayRecoveryIntentQueue } from './relay-recovery-intent-queue'
import { RelayLostRaceDamper } from './mobile-relay-lost-race-damper'
import { MobileRelaySessionEstablisher } from './mobile-relay-session-establisher'
import * as recoveryPresentation from './mobile-relay-recovery-presentation'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason, HostProfile } from './types'
import { MobileRelayBackgroundGrace } from './mobile-relay-background-grace'
import {
  logRelayConnected,
  logRelayCredentialUnavailable,
  logRelayDialFailure
} from './mobile-relay-diagnostic-log'

export type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

const DIRECT_OBSERVATION_MS = 30_000
const MINIMUM_DWELL_MS = 60_000
const FAILURE_COOLDOWN_MS = 60_000

export class MobileEndpointSupervisor {
  private bundle: MobileRelayCredentialBundle | null = null
  private stopped = false
  private operationInFlight = false
  private readonly pending = new RelayRecoveryIntentQueue()
  private readonly nudgeRouter: MobileEndpointNudgeRouter
  private readonly credentialRefresh: MobileRelayCredentialRefresh
  private relayRotationPending = false
  private unsubscribeState: (() => void) | null = null
  private readonly hysteresis: MobileEndpointHysteresis
  private readonly relayReconnect: RelayReconnectController
  private readonly leaseRotation: RelayLeaseRotationTimer
  private readonly logRelay: RelayRecoveryLog
  private readonly directProbe: DirectReturnProbe
  private readonly lostRace: RelayLostRaceDamper
  private readonly backgroundGrace: MobileRelayBackgroundGrace
  private readonly sessionEstablisher: MobileRelaySessionEstablisher

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
    this.credentialRefresh = new MobileRelayCredentialRefresh({
      logical,
      now: dependencies.now,
      randomBytes: dependencies.randomBytes,
      writeBundle: dependencies.writeBundle,
      bundle: () => this.bundle,
      adoptBundle: (bundle) => (this.bundle = bundle),
      persistResolvedRelay: async (resolved) => {
        this.host = await persistRelayHost(this.host, resolved, dependencies.saveHost)
      },
      isStopped: () => this.stopped,
      completeRefresh: () => this.relayReconnect.completeCredentialRefresh(),
      // Why relayDialAllowed and not the reconnect controller's needsRecovery: a
      // refresh that lands while direct is still dialing must start the relay race,
      // not wait on the direct retry loop as the pre-race rotation path did.
      onRefreshed: () => {
        if (this.isActive() && this.relayDialAllowed(false)) {
          void this.recoverRelay()
        }
      }
    })
    this.relayReconnect = new RelayReconnectController(dependencies, this.recoverRelay.bind(this))
    this.relayReconnect.reportRecoveryTo(logical)
    this.nudgeRouter = new MobileEndpointNudgeRouter({
      logical,
      controller: this.relayReconnect,
      isStopped: () => this.stopped,
      isForeground: () => this.backgroundGrace.isForeground(),
      setForeground: (foreground) => this.setForeground(foreground),
      replaceRelay: () => void this.recoverRelay(true, true),
      scheduleDirectProbe: () => this.directProbe.probeNow()
    })
    this.lostRace = new RelayLostRaceDamper(dependencies, () => {
      // Why: the window closing is the moment to re-ask. If direct came back the
      // guards below no-op; if it never did, relay recovery resumes on its own.
      void this.recoverRelay()
    })
    this.leaseRotation = new RelayLeaseRotationTimer(dependencies, () => {
      this.relayRotationPending = true
      void this.recoverRelay(true)
    })
    this.sessionEstablisher = new MobileRelaySessionEstablisher({
      logical,
      controller: this.relayReconnect,
      openRelay: dependencies.openRelay,
      randomBytes: dependencies.randomBytes,
      writeBundle: dependencies.writeBundle,
      isActive: () => this.isActive(),
      isForeground: () => this.backgroundGrace.isForeground(),
      relay: () => this.host.relay,
      resolveRelay: dependencies.resolveRelay,
      persistResolvedRelay: async (resolved) => {
        this.host = await persistRelayHost(this.host, resolved, dependencies.saveHost)
      },
      bundle: () => this.bundle,
      adoptBundle: (bundle) => (this.bundle = bundle),
      recordMigration: () => {
        this.relayRotationPending = false
        this.lostRace.reset()
        this.hysteresis.recordMigration(dependencies.now())
        logRelayConnected(this.logRelay)
      },
      scheduleLease: (expiry) =>
        this.leaseRotation.scheduleFromLease(
          liveRelayLeaseExpiry(this.logical, this.stopped, expiry)
        ),
      scheduleDirectProbe: () => this.directProbe.schedule(),
      onBookkeepingError: (error) =>
        this.logRelay('relay bookkeeping failed after migration', error.message.slice(0, 80)),
      onDialFailure: (error) => logRelayDialFailure(this.logRelay, error)
    })
    this.directProbe = new DirectReturnProbe(dependencies, {
      hysteresis: this.hysteresis,
      host: () => this.host,
      canSchedule: () => this.isActive() && this.logical.getActivePath() === 'relay',
      canDial: () => this.isActive(),
      canAttempt: () => this.isActive() && !this.operationInFlight,
      // Why: a reconnect has no session to protect, so the first authenticated
      // socket wins it outright — hysteresis only arbitrates against a live relay.
      adoptsOutright: () => this.isActive() && this.logical.getState() !== 'connected',
      beginOperation: () => (this.operationInFlight = true),
      migrate: (client, path, abort) => this.logical.migrateTo(client, path, undefined, abort),
      onDirectMigrated: async () => {
        this.leaseRotation.clear()
        this.relayRotationPending = false
        await this.credentialRefresh.run(this.relayReconnect.resetForDirectConnection())
      },
      afterProbe: () => {
        this.operationInFlight = false
        const queued = this.pending.takeRecovery() || this.pending.hasReplacement()
        if (queued || this.relayRotationPending || this.logical.getState() !== 'connected') {
          void this.recoverRelay(this.relayRotationPending)
        }
      }
    })
    this.backgroundGrace = new MobileRelayBackgroundGrace(
      dependencies,
      logical,
      this.relayReconnect,
      this.leaseRotation,
      this.directProbe
    )
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
        this.lostRace.noteDirectRestored()
        if (this.logical.getActivePath() !== 'relay') {
          void this.credentialRefresh.run(this.relayReconnect.resetForDirectConnection())
        }
        this.directProbe.schedule()
        return
      }
      // Why: the path that won the last race is gone, so the window it earned
      // must not be served out — a blip that became an outage would otherwise
      // strand the user for the whole window with nothing else scheduled.
      this.lostRace.clampForLostDirect()
      if (!this.backgroundGrace.isForeground()) {
        this.backgroundGrace.handleStateFailure()
      } else {
        // Why: the direct client enters reconnecting after its first failed
        // dial and may never publish disconnected while its retry loop lives.
        recoveryPresentation.onActiveFailure(this.logical, this.relayReconnect, state, this.bundle)
        const relayFailure = this.relayReconnect.handleStateFailure(this.logical, state)
        logRelayDialFailure(this.logRelay, relayFailure, 'active-session')
      }
    })
    if (this.logical.getState() === 'connected') {
      this.directProbe.schedule()
      return
    }
    // Why: nothing is live, so both paths dial from t=0. This also covers the
    // first direct dial failing while encrypted relay credentials are still
    // loading, before the supervisor subscribes to state changes.
    await this.recoverRelay()
  }

  setForeground(foreground: boolean): void {
    if (foreground) {
      // Why: a resume is the user waiting on the screen, never a blip.
      this.lostRace.reset()
    }
    this.backgroundGrace.setForeground(foreground)
    if (foreground && this.relayRotationPending) {
      void this.recoverRelay(true)
    }
  }

  nudge = (reason: ForegroundNudgeReason): void => this.nudgeRouter.nudge(reason)

  stop(): void {
    this.stopped = true
    this.pending.clear()
    this.lostRace.reset()
    this.directProbe.stop()
    this.unsubscribeState?.()
    this.unsubscribeState = null
    this.backgroundGrace.stop()
  }

  private isActive(): boolean {
    return !this.stopped && this.backgroundGrace.isForeground()
  }

  // Why: the relay dial yields to a live session and to nothing else. An
  // unfinished direct dial ('connecting'/'handshaking') used to block it behind a
  // fixed head start, which bought an off-LAN phone nothing on every reconnect.
  private relayDialAllowed(forceReplacement: boolean): boolean {
    return forceReplacement || this.logical.getState() !== 'connected'
  }

  // forceReplacement: dial past the "a live session already holds the client"
  // guard — a lease rotation or a network-change replacement.
  // ownsRecovery: this dial is the connection's only hope, so a failure books the
  // shared cooldown and any session left stale-'connected' by a half-open socket
  // comes down; lease rotation clears it because armRetry owns its own retry.
  private async recoverRelay(forceReplacement = false, ownsRecovery = false): Promise<void> {
    if (!this.isActive() || !this.host.relay) {
      return
    }
    if (this.logical.getState() !== 'connected') {
      // Why: both paths race from t=0. This no-ops unless relay owns the logical
      // client — when direct owns it, its own session is already redialing.
      this.directProbe.probeNow()
    }
    if (this.operationInFlight) {
      // Why: a direct cutover or a slow post-migration write can own the mutex when
      // a handoff lands. Every request is queued — an owning replacement keeps its
      // force/owns intent, anything else replays as a plain recovery — so the
      // holder's release replays it instead of dropping it.
      this.pending.queue(forceReplacement, ownsRecovery)
      return
    }
    if (this.pending.takeReplacement()) {
      forceReplacement = true
      ownsRecovery = true
    }
    if (!this.relayDialAllowed(forceReplacement)) {
      return
    }
    if (!forceReplacement && this.lostRace.suppresses()) {
      // Why: the previous race was lost to direct and booked nothing, so only
      // this damper stands between a flapping LAN and a cell socket per blip.
      this.logRelay('relay race damped after losing to direct')
      return
    }
    // Why: revival and lease timers can overlap resume failures; one shared cooldown
    // prevents PEER_DROPPED/LIMIT_EXCEEDED reconnect churn.
    if (this.relayReconnect.shouldDefer()) {
      if (ownsRecovery) {
        // Why: never tear down a session no dial has disproven — the intent stays
        // queued so the armed retry runs forced once the cooldown lapses.
        this.pending.holdReplacement()
      }
      this.logRelay('recovery deferred by cooldown or gate')
      return
    }
    this.operationInFlight = true
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
        this.logical.setRecoveryPath(null)
        // Why: "expired" vs "missing" separates a sleep-past-expiry phone
        // (needs re-pair or LAN) from a Keychain failure in field reports.
        logRelayCredentialUnavailable(this.logRelay, selection.bundle !== null)
        this.relayReconnect.armCredentialReprobe()
        if (ownsRecovery) {
          // Why: no dial happened — keep the session and the intent; the reprobe
          // runs forced and replaces make-before-break once a credential exists.
          this.pending.holdReplacement()
        }
        return
      }
      if (!this.isActive() || !this.relayDialAllowed(forceReplacement)) {
        return
      }
      this.logical.setRecoveryPath('relay', this.relayReconnect.getFailureCount())
      const dialed = await this.sessionEstablisher.dialEligible(selection.credentials)
      if (dialed.outcome === 'established') {
        // Why: a fresh socket satisfies any replacement intent queued mid-dial.
        this.pending.clearReplacement()
        retryAfterOperation = this.logical.getState() !== 'connected'
        return
      }
      if (dialed.outcome === 'aborted') {
        this.logical.setRecoveryPath(null)
        // Why: direct won the race or the supervisor went inactive — not a
        // failure; booking backoff would delay the next genuine recovery.
        // Why: only an unforced race can be blip-driven. A forced replacement
        // that stands down is a lease rotation or a network change reconsidered,
        // not a LAN that flapped, so it must not grow the streak.
        if (!forceReplacement && this.isActive() && this.logical.getState() === 'connected') {
          this.lostRace.record()
        }
        return
      }
      // Why: cleanup may happen while a relay dial is awaiting the network;
      // record its outcome without recreating a foreground retry timer.
      const scheduleRetry = (!forceReplacement || ownsRecovery) && this.isActive()
      this.relayReconnect.registerFailure(dialed.error, scheduleRetry)
      recoveryPresentation.clearIfCredentialBlocked(this.logical, this.relayReconnect)
      if (ownsRecovery) {
        suspendRelayIfStillConnected(this.relayReconnect, this.logical)
      }
    } finally {
      this.operationInFlight = false
      const queued = this.pending.takeRecovery()
      if (forceReplacement && this.relayRotationPending && this.isActive()) {
        this.leaseRotation.armRetry(this.relayReconnect.retryDelayMs(5000))
      }
      // Why: the active relay can drop while migration follow-up still owns the mutex.
      if ((retryAfterOperation || queued) && this.isActive()) {
        void this.recoverRelay()
      }
    }
  }
}
