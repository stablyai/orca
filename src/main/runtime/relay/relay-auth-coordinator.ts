import {
  RELAY_HOST_CLOSE_REASON,
  type RelayHostCloseReason
} from '../../../shared/relay-host-close-reason'
import { relayStatusCellUrl } from '../../../shared/mobile-relay-status'
import type { RelayBrokerStatus } from './relay-session-broker'
import type { RelayAccessTokenRefresh } from './relay-session-broker-contract'
import { shouldRetryRelayConnectionError } from './relay-http-client'
import {
  RelayReadinessWaiters,
  relayRetryFloorMs,
  relayUnavailableReasonFor,
  type RelayUnavailable
} from './relay-readiness'
import { RelayRetrySchedule } from './relay-retry-schedule'
import { RelayLingerTimer } from './relay-linger-timer'
import { relayIdentityKey, type RelayAuthContext } from './relay-auth-identity'

export type CoordinatedRelayBroker = {
  closeNow(hostCloseReason?: RelayHostCloseReason): void
  isLive?(): boolean
  readonly endpoint?: { cellUrl: string } | null
}

type RelayAuthCoordinatorOptions = {
  readContext: () => Promise<RelayAuthContext | null>
  hasDemand?: (context: RelayAuthContext) => boolean
  openBroker: (input: {
    context: RelayAuthContext
    isCurrent: () => boolean
    refreshAccessToken: () => Promise<RelayAccessTokenRefresh>
  }) => Promise<CoordinatedRelayBroker>
  onStatus: (status: RelayBrokerStatus, cellUrl?: string) => void
  lingerMs?: number
  random?: () => number
}

export type RelayReadiness =
  | { ready: true; broker: CoordinatedRelayBroker }
  | ({ ready: false } & RelayUnavailable)

type BrokerOwnership = {
  identityKey: string
  broker: CoordinatedRelayBroker | null
  valid: boolean
}

// The single owner of "why the socket died". Why only the null case: readContext
// throws on transient failures and returns null solely when the cloud session is
// gone (absent, or cleared by a 401). A present-but-unentitled context is still a
// signed-in desktop, and "sign in to reconnect" would be wrong advice for it.
function authLossCloseReason(context: RelayAuthContext | null): RelayHostCloseReason | undefined {
  return context ? undefined : RELAY_HOST_CLOSE_REASON.SIGNED_OUT
}

export class RelayAuthCoordinator {
  private readonly options: RelayAuthCoordinatorOptions
  private authEpoch = 0
  private ownership: BrokerOwnership | null = null
  private readonly pendingOwnerships = new Set<BrokerOwnership>()
  private latestReconcile: Promise<void> = Promise.resolve()
  private readonly linger = new RelayLingerTimer()
  private readonly retry: RelayRetrySchedule
  // Why the latest reconcile left no live broker; cleared when one registers.
  private unavailableReason: RelayUnavailable['reason'] | null = null
  private readonly readinessWaiters = new RelayReadinessWaiters()
  private stopped = false

  constructor(options: RelayAuthCoordinatorOptions) {
    this.options = options
    this.retry = new RelayRetrySchedule(options.random)
  }

  reconcile(): void {
    this.beginReconcile(true)
  }

  private beginReconcile(resetRetry: boolean, expectedIdentityKey?: string): void {
    if (this.stopped) {
      return
    }
    this.retry.cancel()
    if (resetRetry) {
      this.retry.reset()
    }
    const epoch = ++this.authEpoch
    this.invalidatePendingOwnerships()
    const reconcile = this.reconcileEpoch(epoch, expectedIdentityKey)
    this.latestReconcile = reconcile
    void reconcile
  }

  // hostCloseReason names an auth loss the phone should be told about. Quit,
  // relaunch and every other fence pass nothing, so the control socket dies
  // abruptly exactly as before and the cell records no cause.
  fenceAndCloseNow(hostCloseReason?: RelayHostCloseReason): void {
    ++this.authEpoch
    this.linger.cancel()
    this.retry.cancel()
    this.retry.reset()
    this.invalidatePendingOwnerships()
    this.invalidateOwnership(hostCloseReason)
    this.unavailableReason =
      hostCloseReason === RELAY_HOST_CLOSE_REASON.SIGNED_OUT ? 'signed_out' : null
    this.readinessWaiters.releaseAll()
    this.publish('offline')
  }

  // Why derived rather than passed in: the coordinator republishes `registered`
  // after the broker already announced its cell, so a call site that forgot the
  // cell would silently blank it moments after the broker set it.
  private publish(status: RelayBrokerStatus): void {
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

  readiness(): RelayReadiness {
    const broker = this.getLiveBroker()
    const reason = this.unavailableReason ?? 'control_not_active'
    return broker ? { ready: true, broker } : { ready: false, reason, retryAt: this.retry.retryAt }
  }

  // Awaits the reconcile in flight (and any it was superseded by), never a retry.
  async waitForLiveBroker(): Promise<CoordinatedRelayBroker | null> {
    let pending: Promise<void> | null = null
    while (!this.stopped && !this.getLiveBroker() && pending !== this.latestReconcile) {
      pending = this.latestReconcile
      await pending
    }
    return this.stopped ? null : this.getLiveBroker()
  }

  // Why waitMs: a cold start that fails once arms a retry seconds away; a caller
  // with time to spare waits for it instead of reporting the first failure. The
  // deadline bounds every wait, and a fence releases the caller at once.
  async waitForReadiness(waitMs: number): Promise<RelayReadiness> {
    const deadline = Date.now() + waitMs
    while (!this.stopped && !this.getLiveBroker()) {
      const pending = this.latestReconcile
      if (!(await this.readinessWaiters.until(pending, deadline))) {
        break
      }
      if (pending !== this.latestReconcile) {
        continue
      }
      const retryAt = this.retry.retryAt
      if (this.getLiveBroker() || retryAt === null || retryAt > deadline) {
        break
      }
      const retried = await this.readinessWaiters.until(this.retry.settled(), deadline)
      if (!retried || pending === this.latestReconcile) {
        break
      }
    }
    return this.readiness()
  }

  stop(): void {
    this.stopped = true
    this.fenceAndCloseNow()
  }

  private async reconcileEpoch(epoch: number, expectedIdentityKey?: string): Promise<void> {
    let retryIdentityKey: string | undefined
    try {
      const context = await this.options.readContext()
      if (!this.isEpochCurrent(epoch)) {
        return
      }
      if (!context || !context.relayEntitled) {
        this.linger.cancel()
        this.retry.reset()
        this.invalidateOwnership(authLossCloseReason(context))
        this.unavailableReason = context ? 'not_entitled' : 'signed_out'
        this.publish('offline')
        return
      }
      const nextIdentityKey = relayIdentityKey(context.identity)
      if (expectedIdentityKey && nextIdentityKey !== expectedIdentityKey) {
        this.retry.reset()
        this.unavailableReason = 'identity_changed'
        this.publish('offline')
        return
      }
      if (!(this.options.hasDemand?.(context) ?? true)) {
        this.retry.reset()
        if (this.ownership?.valid && this.ownership.identityKey !== nextIdentityKey) {
          this.linger.cancel()
          this.invalidateOwnership()
        } else if (this.ownership?.valid) {
          this.scheduleLinger(context, this.ownership)
        }
        this.publish('standby')
        return
      }
      this.linger.cancel()
      if (
        this.ownership?.valid &&
        this.ownership.identityKey === nextIdentityKey &&
        // Why: registered must be provable; a broker whose control died without
        // recovering falls through and is replaced instead of republished.
        (this.ownership.broker?.isLive?.() ?? true)
      ) {
        this.retry.reset()
        this.unavailableReason = null
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
      this.unavailableReason = null
      this.publish('registered')
    } catch (error) {
      if (this.isEpochCurrent(epoch)) {
        // Why: silent broker-open failures made a dead relay look like standby
        // during incident diagnosis; the message carries operation + status.
        console.warn(
          '[relay] broker reconcile failed:',
          error instanceof Error ? error.message : String(error)
        )
        this.unavailableReason = relayUnavailableReasonFor(error)
        this.publish('offline')
        if (shouldRetryRelayConnectionError(error)) {
          const retryAfterMs = relayRetryFloorMs(error, this.retry.attempts)
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
  ): Promise<RelayAccessTokenRefresh> {
    if (!ownership.valid || this.stopped) {
      return { accessToken: null }
    }
    const epoch = this.authEpoch
    const context = await this.options.readContext()
    // A superseded refresh names no reason: whoever superseded it owns the close.
    if (!ownership.valid || !this.isEpochCurrent(epoch)) {
      return { accessToken: null }
    }
    if (!context?.relayEntitled || relayIdentityKey(context.identity) !== expectedIdentityKey) {
      return { accessToken: null, hostCloseReason: authLossCloseReason(context) }
    }
    return { accessToken: context.accessToken }
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
    this.linger.arm(this.options.lingerMs ?? 10 * 60_000, () => {
      if (
        this.ownership === ownership &&
        ownership.valid &&
        !(this.options.hasDemand?.(context) ?? true)
      ) {
        this.invalidateOwnership()
        this.publish('standby')
      }
    })
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
