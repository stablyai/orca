type SubscriptionCleanup = () => void | Promise<void>

export type SubscriptionRegistration = {
  releaseIfCurrent(): void
}

export class RuntimeSubscriptionRegistry {
  private readonly cleanups = new Map<string, SubscriptionCleanup>()
  private readonly cleanupPromises = new Map<
    string,
    { cleanup: SubscriptionCleanup; promise: Promise<void> }
  >()
  private readonly subscriptionsByConnection = new Map<string, Set<string>>()
  private readonly connectionBySubscription = new Map<string, string>()

  register(subscriptionId: string, cleanup: SubscriptionCleanup, connectionId?: string): void {
    const existing = this.cleanups.get(subscriptionId)
    if (existing) {
      this.removeConnectionIndex(subscriptionId)
      this.cleanup(subscriptionId)
    }
    this.cleanups.set(subscriptionId, cleanup)
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
    return { releaseIfCurrent: () => this.cleanupOwned(subscriptionId, cleanup) }
  }

  cleanupIfOwnedByConnection(subscriptionId: string, connectionId?: string): boolean {
    if (!connectionId) {
      this.cleanup(subscriptionId)
      return true
    }
    if (!this.cleanups.has(subscriptionId)) {
      return true
    }
    if (this.connectionBySubscription.get(subscriptionId) !== connectionId) {
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
    const failedGeneration = this.cleanupPromises.get(subscriptionId)
    void gate.then(
      async () => {
        await (failedGeneration?.cleanup === cleanupOwner
          ? failedGeneration.promise.catch(() => undefined)
          : undefined)
        while (this.cleanups.get(subscriptionId) === cleanupOwner) {
          const newerGeneration = this.cleanupPromises.get(subscriptionId)
          if (newerGeneration?.cleanup === cleanupOwner) {
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
    const cleanup = this.cleanups.get(subscriptionId)
    if (!cleanup) {
      return
    }
    const inFlight = this.cleanupPromises.get(subscriptionId)
    if (inFlight?.cleanup === cleanup) {
      return inFlight.promise
    }
    let cleanupResult: void | Promise<void>
    try {
      cleanupResult = cleanup()
    } catch (error) {
      cleanupResult = Promise.reject(error)
    }
    const promise = Promise.resolve(cleanupResult)
      .then(() => {
        if (this.cleanups.get(subscriptionId) !== cleanup) {
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
    this.cleanupPromises.set(subscriptionId, { cleanup, promise })
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

  private cleanupOwned(subscriptionId: string, expectedCleanup: SubscriptionCleanup): void {
    if (this.cleanups.get(subscriptionId) !== expectedCleanup) {
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
