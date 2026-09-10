import {
  RELAY_HOST_CLOSE_REASON,
  type RelayHostCloseReason
} from '../../../shared/relay-host-close-reason'
import { relayStatusCellUrl } from '../../../shared/mobile-relay-status'
import type { RelayBrokerStatus } from './relay-session-broker'
import { RelayHttpError, shouldRetryRelayConnectionError } from './relay-http-client'
import type { RelayOfflineReason } from './relay-offline-reason'
import { RelayRetrySchedule } from './relay-retry-schedule'
import { withTimeout } from '../../../shared/promise-timeout-fallback'
import type {
  CoordinatedRelayBroker,
  LiveBrokerWaitResult,
  RelayAuthContext,
  RelayAuthCoordinatorOptions,
  RelayAuthIdentity,
  RelayReconcileOptions as ReconcileOptions
} from './relay-auth-coordinator-contract'

export type {
  CoordinatedRelayBroker,
  LiveBrokerWaitResult,
  RelayAuthContext,
  RelayAuthIdentity
} from './relay-auth-coordinator-contract'

type BrokerOwnership = {
  identityKey: string
  broker: CoordinatedRelayBroker | null
  valid: boolean
}

function identityKey(identity: RelayAuthIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}

function offlineReasonForOpenFailure(
  retryable: boolean,
  reachedRelay: string | undefined
): RelayOfflineReason {
  if (reachedRelay === undefined) {
    return 'auth_unavailable'
  }
  return retryable ? 'broker_unavailable' : 'broker_rejected'
}

export class RelayAuthCoordinator {
  // Why 20s: bounds only how long a waiter sits through armed retries, never
  // an open already in flight. It spans the first few rungs of the backoff
  // ladder and stays inside the phone's 30s request budget, so a sustained
  // outage fails the caller with its cause instead of parking the demand ref.
  private static readonly LIVE_BROKER_WAIT_BUDGET_MS = 20_000
  private readonly options: RelayAuthCoordinatorOptions
  private authEpoch = 0
  private offlineReason: RelayOfflineReason | null = null
  private ownership: BrokerOwnership | null = null
  private readonly pendingOwnerships = new Set<BrokerOwnership>()
  private latestReconcile: Promise<void> = Promise.resolve()
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private readonly retry: RelayRetrySchedule
  private stopped = false

  constructor(options: RelayAuthCoordinatorOptions) {
    this.options = options
    this.retry = new RelayRetrySchedule(options.random)
  }

  reconcile(options?: ReconcileOptions): void {
    this.beginReconcile(true, undefined, options)
  }

  private beginReconcile(
    resetRetry: boolean,
    expectedIdentityKey?: string,
    options?: ReconcileOptions
  ): void {
    if (this.stopped) {
      return
    }
    this.retry.cancel()
    if (resetRetry) {
      this.retry.reset()
    }
    const epoch = ++this.authEpoch
    this.invalidatePendingOwnerships()
    const reconcile = this.reconcileEpoch(epoch, expectedIdentityKey, options)
    this.latestReconcile = reconcile
    void reconcile
  }

  // hostCloseReason names an auth loss the phone should be told about. Quit,
  // relaunch and every other fence pass nothing, so the control socket dies
  // abruptly exactly as before and the cell records no cause.
  fenceAndCloseNow(hostCloseReason?: RelayHostCloseReason): void {
    ++this.authEpoch
    this.cancelLinger()
    this.retry.cancel()
    this.retry.reset()
    this.invalidatePendingOwnerships()
    this.invalidateOwnership(hostCloseReason)
    this.publish('offline', hostCloseReason)
  }

  // Why derived rather than passed in: the coordinator republishes `registered`
  // after the broker already announced its cell, so a call site that forgot the
  // cell would silently blank it moments after the broker set it.
  private publish(status: RelayBrokerStatus, offlineReason?: RelayOfflineReason): void {
    // Why only 'offline' keeps a reason: requireActiveBroker reads it to name
    // the cause, and a stale reason must not survive the coordinator going
    // back online (or offline again for an unrelated, unclassified cause).
    this.offlineReason = status === 'offline' ? (offlineReason ?? null) : null
    this.options.onStatus(
      status,
      relayStatusCellUrl(status, this.ownership?.broker?.endpoint?.cellUrl)
    )
  }

  // Raw ownership handle for identity matching (revoke routing); control work uses getLiveBroker.
  getActiveBroker(): CoordinatedRelayBroker | null {
    return this.ownership?.valid ? this.ownership.broker : null
  }

  // Why: ownership stays valid across a control death, so control work must
  // apply the same liveness gate reconcile does; unprovable liveness stays usable.
  getLiveBroker(): CoordinatedRelayBroker | null {
    const broker = this.getActiveBroker()
    return broker && (broker.isLive?.() ?? true) ? broker : null
  }

  // Why: some broker deaths end with no retry timer — an auth refresh that
  // fails past token expiry (laptop sleep), or a transient context read that
  // returned null at open. Periodic/power-resume callers use this as a
  // dead-man's switch; it never disturbs a live broker, a scheduled retry,
  // or an open already in flight.
  ensureLive(): void {
    if (this.stopped || this.retry.pending || this.pendingOwnerships.size > 0) {
      return
    }
    const ownership = this.ownership
    if (ownership?.valid && (ownership.broker?.isLive?.() ?? true)) {
      return
    }
    this.beginReconcile(false)
  }

  async waitForLiveBroker(budgetMs?: number): Promise<CoordinatedRelayBroker | null> {
    return (await this.waitForLiveBrokerResult(budgetMs)).broker
  }

  // Why the caller maps offlineReason to a code instead of the coordinator
  // throwing: the mint-failure vocabulary belongs to the RPC layer.
  async waitForLiveBrokerResult(
    budgetMs = RelayAuthCoordinator.LIVE_BROKER_WAIT_BUDGET_MS
  ): Promise<LiveBrokerWaitResult> {
    const deadline = Date.now() + budgetMs
    while (!this.stopped) {
      const broker = this.getLiveBroker()
      if (broker) {
        return { broker }
      }
      const pending = this.latestReconcile
      // Why unbounded: a reconcile always settles (opens carry HTTP deadlines),
      // and cutting a slow-but-succeeding open short would fail a pairing that
      // was about to work. The budget bounds only the retry chain below.
      await pending
      if (pending !== this.latestReconcile) {
        continue
      }
      // Why: a reconcile that failed transiently has already armed its own
      // retry; returning now would surface a hiccup fixed moments later. A
      // terminal outcome (signed out, unentitled, rejected) arms nothing, so
      // its cause returns without waiting.
      const armed = this.retry.settled
      if (!armed || Date.now() >= deadline) {
        return this.settledLiveBrokerResult()
      }
      await withTimeout(armed, deadline - Date.now(), undefined)
    }
    return this.settledLiveBrokerResult()
  }

  private settledLiveBrokerResult(): LiveBrokerWaitResult {
    const broker = this.getLiveBroker()
    return broker ? { broker } : { broker: null, offlineReason: this.offlineReason }
  }

  stop(): void {
    this.stopped = true
    this.fenceAndCloseNow()
  }

  private async reconcileEpoch(
    epoch: number,
    expectedIdentityKey?: string,
    options?: ReconcileOptions
  ): Promise<void> {
    let retryIdentityKey: string | undefined
    try {
      const context = await this.options.readContext()
      if (!this.isEpochCurrent(epoch)) {
        return
      }
      if (!context || !context.relayEntitled) {
        this.cancelLinger()
        this.retry.reset()
        // Why only the null case: readContext throws on transient failures and
        // returns null solely when the cloud session is gone (absent, or cleared
        // by a 401). A present-but-unentitled context is still a signed-in
        // desktop, and "sign in to reconnect" would be wrong advice for it.
        this.invalidateOwnership(context ? undefined : RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
        this.publish('offline', context ? 'not_entitled' : RELAY_HOST_CLOSE_REASON.SIGNED_OUT)
        return
      }
      const nextIdentityKey = identityKey(context.identity)
      if (expectedIdentityKey && nextIdentityKey !== expectedIdentityKey) {
        this.retry.reset()
        this.publish('offline')
        return
      }
      if (!(this.options.hasDemand?.(context) ?? true)) {
        this.retry.reset()
        if (
          this.ownership?.valid &&
          (options?.skipLinger || this.ownership.identityKey !== nextIdentityKey)
        ) {
          this.cancelLinger()
          this.invalidateOwnership()
        } else if (this.ownership?.valid) {
          this.scheduleLinger(context, this.ownership)
        }
        this.publish('standby')
        return
      }
      this.cancelLinger()
      if (
        this.ownership?.valid &&
        this.ownership.identityKey === nextIdentityKey &&
        // Why: registered must be provable; a broker whose control died without
        // recovering falls through and is replaced instead of republished.
        (this.ownership.broker?.isLive?.() ?? true)
      ) {
        this.retry.reset()
        this.publish('registered')
        return
      }
      retryIdentityKey = nextIdentityKey
      this.invalidateOwnership()
      this.publish('connecting')
      const ownership: BrokerOwnership = {
        identityKey: nextIdentityKey,
        broker: null,
        valid: true
      }
      this.pendingOwnerships.add(ownership)
      const isCurrent = (): boolean =>
        ownership.valid &&
        !this.stopped &&
        (ownership.broker ? this.ownership === ownership : this.isEpochCurrent(epoch))
      let broker: CoordinatedRelayBroker
      try {
        broker = await this.options.openBroker({
          context,
          isCurrent,
          refreshAccessToken: () => this.refreshAccessToken(ownership, nextIdentityKey)
        })
      } finally {
        this.pendingOwnerships.delete(ownership)
      }
      ownership.broker = broker
      if (!this.isEpochCurrent(epoch) || !ownership.valid) {
        broker.closeNow()
        return
      }
      this.ownership = ownership
      this.retry.reset()
      this.publish('registered')
    } catch (error) {
      if (this.isEpochCurrent(epoch)) {
        // Why: silent broker-open failures made a dead relay look like standby
        // during incident diagnosis; the message carries operation + status.
        console.warn(
          '[relay] broker reconcile failed:',
          error instanceof Error ? error.message : String(error)
        )
        const retryable = shouldRetryRelayConnectionError(error)
        // retryIdentityKey is set only once the context read succeeded, so its
        // absence means the failure never reached the relay.
        this.publish('offline', offlineReasonForOpenFailure(retryable, retryIdentityKey))
        if (retryable) {
          const retryAfterMs = error instanceof RelayHttpError ? (error.retryAfterMs ?? 0) : 0
          this.scheduleRetry(epoch, retryIdentityKey, retryAfterMs)
        }
      }
    }
  }

  private scheduleRetry(epoch: number, expectedIdentityKey?: string, retryAfterMs = 0): void {
    if (!this.isEpochCurrent(epoch)) {
      return
    }
    this.retry.schedule(retryAfterMs, () => {
      if (this.isEpochCurrent(epoch)) {
        // Retry still re-reads entitlement and demand; the timer grants no authority.
        this.beginReconcile(false, expectedIdentityKey)
      }
    })
  }

  private async refreshAccessToken(
    ownership: { valid: boolean },
    expectedIdentityKey: string
  ): Promise<string | null> {
    if (!ownership.valid || this.stopped) {
      return null
    }
    const epoch = this.authEpoch
    const context = await this.options.readContext()
    if (
      !ownership.valid ||
      !this.isEpochCurrent(epoch) ||
      !context?.relayEntitled ||
      identityKey(context.identity) !== expectedIdentityKey
    ) {
      return null
    }
    return context.accessToken
  }

  private invalidateOwnership(hostCloseReason?: RelayHostCloseReason): void {
    const ownership = this.ownership
    this.ownership = null
    if (ownership) {
      ownership.valid = false
      ownership.broker?.closeNow(hostCloseReason)
    }
  }

  private scheduleLinger(context: RelayAuthContext, ownership: BrokerOwnership): void {
    if (this.lingerTimer) {
      return
    }
    const lingerMs = this.options.lingerMs ?? 10 * 60_000
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null
      if (
        this.ownership === ownership &&
        ownership.valid &&
        !(this.options.hasDemand?.(context) ?? true)
      ) {
        this.invalidateOwnership()
        this.publish('standby')
      }
    }, lingerMs)
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }
  }

  private invalidatePendingOwnerships(): void {
    for (const ownership of this.pendingOwnerships) {
      ownership.valid = false
    }
    this.pendingOwnerships.clear()
  }

  private isEpochCurrent(epoch: number): boolean {
    return !this.stopped && this.authEpoch === epoch
  }
}
