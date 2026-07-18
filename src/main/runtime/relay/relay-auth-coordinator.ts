import type { RelayBrokerStatus } from './relay-session-broker'

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
  private readonly options: RelayAuthCoordinatorOptions
  private authEpoch = 0
  private ownership: BrokerOwnership | null = null
  private readonly pendingOwnerships = new Set<BrokerOwnership>()
  private latestReconcile: Promise<void> = Promise.resolve()
  private lingerTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = false

  constructor(options: RelayAuthCoordinatorOptions) {
    this.options = options
  }

  reconcile(): void {
    if (this.stopped) {
      return
    }
    const epoch = ++this.authEpoch
    this.invalidatePendingOwnerships()
    const reconcile = this.reconcileEpoch(epoch)
    this.latestReconcile = reconcile
    void reconcile
  }

  fenceAndCloseNow(): void {
    ++this.authEpoch
    this.cancelLinger()
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

  private async reconcileEpoch(epoch: number): Promise<void> {
    try {
      const context = await this.options.readContext()
      if (!this.isEpochCurrent(epoch)) {
        return
      }
      if (!context || !context.relayEntitled) {
        this.cancelLinger()
        this.invalidateOwnership()
        this.options.onStatus('offline')
        return
      }
      const nextIdentityKey = identityKey(context.identity)
      if (!(this.options.hasDemand?.(context) ?? true)) {
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
        this.options.onStatus('registered')
        return
      }
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
      this.options.onStatus('registered')
    } catch {
      if (this.isEpochCurrent(epoch)) {
        this.options.onStatus('offline')
      }
    }
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
