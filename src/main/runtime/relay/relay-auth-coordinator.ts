import type { RelayBrokerStatus } from './relay-session-broker'
import { shouldRetryRelayConnectionError } from './relay-http-client'

export type RelayAuthIdentity = {
  userId: string
  profileId: string
  organizationId: string
}

export type RelayAuthContext = {
  identity: RelayAuthIdentity
  accessToken: string
  relayEntitled: boolean
}

export type CoordinatedRelayBroker = {
  closeNow(): void
}

type RelayAuthCoordinatorOptions = {
  readContext: () => Promise<RelayAuthContext | null>
  hasDemand?: (context: RelayAuthContext) => boolean
  openBroker: (input: {
    context: RelayAuthContext
    isCurrent: () => boolean
    refreshAccessToken: () => Promise<string | null>
  }) => Promise<CoordinatedRelayBroker>
  onStatus: (status: RelayBrokerStatus) => void
  lingerMs?: number
  random?: () => number
}

type BrokerOwnership = {
  identityKey: string
  broker: CoordinatedRelayBroker | null
  valid: boolean
}

function identityKey(identity: RelayAuthIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}

export class RelayAuthCoordinator {
  // Why: recover brief failures quickly without turning a sustained outage into auth/director load.
  private static readonly RETRY_BASE_MS = 1_000
  private static readonly RETRY_MAX_MS = 5 * 60_000
  private readonly options: RelayAuthCoordinatorOptions
  private authEpoch = 0
  private ownership: BrokerOwnership | null = null
  private readonly pendingOwnerships = new Set<BrokerOwnership>()
  private latestReconcile: Promise<void> = Promise.resolve()
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryAttempt = 0
  private stopped = false

  constructor(options: RelayAuthCoordinatorOptions) {
    this.options = options
  }

  reconcile(): void {
    this.beginReconcile(true)
  }

  private beginReconcile(resetRetry: boolean, expectedIdentityKey?: string): void {
    if (this.stopped) {
      return
    }
    this.cancelRetry()
    if (resetRetry) {
      this.retryAttempt = 0
    }
    const epoch = ++this.authEpoch
    this.invalidatePendingOwnerships()
    const reconcile = this.reconcileEpoch(epoch, expectedIdentityKey)
    this.latestReconcile = reconcile
    void reconcile
  }

  fenceAndCloseNow(): void {
    ++this.authEpoch
    this.cancelLinger()
    this.cancelRetry()
    this.retryAttempt = 0
    this.invalidatePendingOwnerships()
    this.invalidateOwnership()
    this.options.onStatus('offline')
  }

  getActiveBroker(): CoordinatedRelayBroker | null {
    return this.ownership?.valid ? this.ownership.broker : null
  }

  async waitForActiveBroker(): Promise<CoordinatedRelayBroker | null> {
    while (!this.stopped) {
      const broker = this.getActiveBroker()
      if (broker) {
        return broker
      }
      const pending = this.latestReconcile
      await pending
      if (pending === this.latestReconcile) {
        return this.getActiveBroker()
      }
    }
    return null
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
        this.cancelLinger()
        this.retryAttempt = 0
        this.invalidateOwnership()
        this.options.onStatus('offline')
        return
      }
      const nextIdentityKey = identityKey(context.identity)
      if (expectedIdentityKey && nextIdentityKey !== expectedIdentityKey) {
        this.retryAttempt = 0
        this.options.onStatus('offline')
        return
      }
      if (!(this.options.hasDemand?.(context) ?? true)) {
        this.retryAttempt = 0
        if (this.ownership?.valid && this.ownership.identityKey !== nextIdentityKey) {
          this.cancelLinger()
          this.invalidateOwnership()
        } else if (this.ownership?.valid) {
          this.scheduleLinger(context, this.ownership)
        }
        this.options.onStatus('standby')
        return
      }
      this.cancelLinger()
      if (this.ownership?.valid && this.ownership.identityKey === nextIdentityKey) {
        this.retryAttempt = 0
        this.options.onStatus('registered')
        return
      }
      retryIdentityKey = nextIdentityKey
      this.invalidateOwnership()
      this.options.onStatus('connecting')
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
      this.retryAttempt = 0
      this.options.onStatus('registered')
    } catch (error) {
      if (this.isEpochCurrent(epoch)) {
        this.options.onStatus('offline')
        if (shouldRetryRelayConnectionError(error)) {
          this.scheduleRetry(epoch, retryIdentityKey)
        }
      }
    }
  }

  private scheduleRetry(epoch: number, expectedIdentityKey?: string): void {
    if (this.retryTimer || !this.isEpochCurrent(epoch)) {
      return
    }
    const exponent = Math.min(
      this.retryAttempt,
      Math.ceil(Math.log2(RelayAuthCoordinator.RETRY_MAX_MS / RelayAuthCoordinator.RETRY_BASE_MS))
    )
    const capMs = Math.min(
      RelayAuthCoordinator.RETRY_MAX_MS,
      RelayAuthCoordinator.RETRY_BASE_MS * 2 ** exponent
    )
    this.retryAttempt++
    const random = this.options.random ?? Math.random
    const delayMs = Math.floor(random() * (capMs + 1))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.isEpochCurrent(epoch)) {
        // Retry still re-reads entitlement and demand; the timer grants no authority.
        this.beginReconcile(false, expectedIdentityKey)
      }
    }, delayMs)
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

  private invalidateOwnership(): void {
    const ownership = this.ownership
    this.ownership = null
    if (ownership) {
      ownership.valid = false
      ownership.broker?.closeNow()
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
        this.options.onStatus('standby')
      }
    }, lingerMs)
  }

  private cancelLinger(): void {
    if (this.lingerTimer) {
      clearTimeout(this.lingerTimer)
      this.lingerTimer = null
    }
  }

  private cancelRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
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
