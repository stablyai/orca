type SubscriptionCleanup = () => void | Promise<void>

type RequestAddress = { connectionId: string; requestId: string }

const requestKey = ({ connectionId, requestId }: RequestAddress): string =>
  JSON.stringify([connectionId, requestId])

type SubscriptionEntry = {
  cleanup: SubscriptionCleanup
  version: number
  request?: RequestAddress
}

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
  private readonly subscriptionsByRequest = new Map<
    string,
    { subscriptionId: string; version: number }
  >()
  private registrationVersion = 0

  getRegistrationVersion(): number {
    return this.registrationVersion
  }

  register(
    subscriptionId: string,
    cleanup: SubscriptionCleanup,
    connectionId?: string,
    requestId?: string
  ): void {
    const existing = this.cleanups.get(subscriptionId)
    if (existing) {
      this.removeConnectionIndex(subscriptionId)
      this.removeRequestIndex(existing)
      this.cleanup(subscriptionId)
    }
    const version = ++this.registrationVersion
    const request = connectionId && requestId ? { connectionId, requestId } : undefined
    this.cleanups.set(subscriptionId, { cleanup, version, request })
    if (request) {
      // Why: IPC reuses a request id after aborting its previous subscription, so the newer one owns the address.
      this.subscriptionsByRequest.set(requestKey(request), { subscriptionId, version })
    }
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
    connectionId?: string,
    requestId?: string
  ): SubscriptionRegistration {
    this.register(subscriptionId, cleanup, connectionId, requestId)
    const version = this.registrationVersion
    return { releaseIfCurrent: () => this.cleanupOwned(subscriptionId, version) }
  }

  /** Releases the registration a request created; an unknown, ended or replaced request is a no-op. */
  releaseByRequest(connectionId: string | undefined, requestId: string): void {
    // Why: some non-phone sockets carry no connection id, and a bare request id is not unique across sockets.
    if (!connectionId) {
      return
    }
    const target = this.subscriptionsByRequest.get(requestKey({ connectionId, requestId }))
    if (target) {
      this.cleanupOwned(target.subscriptionId, target.version)
    }
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
        this.removeRequestIndex(entry)
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

  /** Compare-and-delete: a newer registration that reused the request id keeps its address. */
  private removeRequestIndex(entry: SubscriptionEntry): void {
    if (!entry.request) {
      return
    }
    const key = requestKey(entry.request)
    if (this.subscriptionsByRequest.get(key)?.version === entry.version) {
      this.subscriptionsByRequest.delete(key)
    }
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
