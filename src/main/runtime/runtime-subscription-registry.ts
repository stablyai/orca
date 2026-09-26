type SubscriptionCleanup = () => void | Promise<void>

type SubscriptionEntry = { cleanup: SubscriptionCleanup; version: number }

export type SubscriptionRegistration = {
  releaseIfCurrent(): void
}

export class RuntimeSubscriptionRegistry {
  private readonly cleanups = new Map<string, SubscriptionEntry>()
  private readonly cleanupPromises = new Map<
    string,
    { entry: SubscriptionEntry; promise: Promise<void> }
  >()
  private readonly subscriptionsByConnection = new Map<string, Set<string>>()
  private readonly connectionBySubscription = new Map<string, string>()
  private registrationVersion = 0

  getRegistrationVersion(): number {
    return this.registrationVersion
  }

  register(subscriptionId: string, cleanup: SubscriptionCleanup, connectionId?: string): void {
    const existing = this.cleanups.get(subscriptionId)
    if (existing) {
      this.removeConnectionIndex(subscriptionId)
      this.cleanup(subscriptionId)
    }
    this.cleanups.set(subscriptionId, { cleanup, version: ++this.registrationVersion })
    if (!connectionId) {
      return
    }
    let set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      set = new Set()
      this.subscriptionsByConnection.set(connectionId, set)
    }
    set.add(subscriptionId)
    this.connectionBySubscription.set(subscriptionId, connectionId)
  }

  registerOwned(
    subscriptionId: string,
    cleanup: SubscriptionCleanup,
    connectionId?: string
  ): SubscriptionRegistration {
    this.register(subscriptionId, cleanup, connectionId)
    const version = this.registrationVersion
    return { releaseIfCurrent: () => this.cleanupOwned(subscriptionId, version) }
  }

  cleanupIfOwnedByConnection(
    subscriptionId: string,
    connectionId?: string,
    throughVersion?: number
  ): boolean {
    const entry = this.cleanups.get(subscriptionId)
    if (!entry) {
      return true
    }
    if (throughVersion !== undefined && entry.version > throughVersion) {
      return false
    }
    if (connectionId && this.connectionBySubscription.get(subscriptionId) !== connectionId) {
      return false
    }
    this.cleanup(subscriptionId)
    return true
  }

  cleanup(subscriptionId: string): void {
    void this.cleanupAndWait(subscriptionId).catch((error) => {
      console.error(`[runtime] subscription cleanup failed for ${subscriptionId}:`, error)
    })
  }

  retryAfter(subscriptionId: string, cleanupOwner: SubscriptionCleanup, gate: Promise<void>): void {
    const entry = this.cleanups.get(subscriptionId)
    const failedGeneration = this.cleanupPromises.get(subscriptionId)
    void gate.then(
      async () => {
        if (entry?.cleanup !== cleanupOwner) {
          return
        }
        await (failedGeneration?.entry === entry
          ? failedGeneration.promise.catch(() => undefined)
          : undefined)
        while (this.cleanups.get(subscriptionId) === entry) {
          const newerGeneration = this.cleanupPromises.get(subscriptionId)
          if (newerGeneration?.entry === entry) {
            await newerGeneration.promise.catch(() => undefined)
            continue
          }
          this.cleanup(subscriptionId)
          return
        }
      },
      () => undefined
    )
  }

  async cleanupAndWait(subscriptionId: string): Promise<void> {
    const entry = this.cleanups.get(subscriptionId)
    if (!entry) {
      return
    }
    const inFlight = this.cleanupPromises.get(subscriptionId)
    if (inFlight?.entry === entry) {
      return inFlight.promise
    }
    let cleanupResult: void | Promise<void>
    try {
      cleanupResult = entry.cleanup()
    } catch (error) {
      cleanupResult = Promise.reject(error)
    }
    const promise = Promise.resolve(cleanupResult)
      .then(() => {
        if (this.cleanups.get(subscriptionId) !== entry) {
          return
        }
        this.cleanups.delete(subscriptionId)
        this.removeConnectionIndex(subscriptionId)
      })
      .finally(() => {
        if (this.cleanupPromises.get(subscriptionId)?.promise === promise) {
          this.cleanupPromises.delete(subscriptionId)
        }
      })
    this.cleanupPromises.set(subscriptionId, { entry, promise })
    return promise
  }

  cleanupByPrefix(prefix: string): void {
    const ids = Array.from(this.cleanups.keys()).filter((id) => id.startsWith(prefix))
    for (const id of ids) {
      this.cleanup(id)
    }
  }

  cleanupForConnection(connectionId: string): void {
    const set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      return
    }
    for (const id of Array.from(set)) {
      if (this.connectionBySubscription.get(id) !== connectionId) {
        set.delete(id)
        continue
      }
      this.cleanup(id)
    }
    if (set.size === 0) {
      this.subscriptionsByConnection.delete(connectionId)
    }
  }

  private cleanupOwned(subscriptionId: string, expectedVersion: number): void {
    if (this.cleanups.get(subscriptionId)?.version !== expectedVersion) {
      return
    }
    this.cleanup(subscriptionId)
  }

  private removeConnectionIndex(subscriptionId: string): void {
    const connectionId = this.connectionBySubscription.get(subscriptionId)
    if (!connectionId) {
      return
    }
    this.connectionBySubscription.delete(subscriptionId)
    const set = this.subscriptionsByConnection.get(connectionId)
    if (!set) {
      return
    }
    set.delete(subscriptionId)
    if (set.size === 0) {
      this.subscriptionsByConnection.delete(connectionId)
    }
  }
}
