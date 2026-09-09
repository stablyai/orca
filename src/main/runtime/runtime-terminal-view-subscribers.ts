type RuntimeTerminalViewSubscriberDependencies = {
  notifyPresenceChanged: (ptyId: string) => void
  hasMobileSubscribers: (ptyId: string) => boolean
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

export class RuntimeTerminalViewSubscribers {
  private readonly remoteCounts = new Map<string, number>()
  private readonly rawCounts = new Map<string, number>()
  private readonly providerAttaches = new Map<string, Promise<boolean>>()
  private readonly attachInventoryWaiters = new Set<string>()
  private readonly spawnPublishedPtys = new Set<string>()

  constructor(private readonly deps: RuntimeTerminalViewSubscriberDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.spawnPublishedPtys.add(ptyId)
  }

  resetGeneration(ptyId: string): void {
    this.providerAttaches.delete(ptyId)
    this.attachInventoryWaiters.delete(ptyId)
    this.spawnPublishedPtys.delete(ptyId)
  }

  // Why: exit drops subscribers only; attach/publish state survives until the respawn advances the generation.
  clearSubscribers(ptyId: string): void {
    this.remoteCounts.delete(ptyId)
    this.rawCounts.delete(ptyId)
  }

  registerRemote(ptyId: string): () => void {
    this.remoteCounts.set(ptyId, (this.remoteCounts.get(ptyId) ?? 0) + 1)
    this.ensureProviderAttach(ptyId)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.remoteCounts, ptyId)
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  registerRaw(ptyId: string): () => void {
    this.rawCounts.set(ptyId, (this.rawCounts.get(ptyId) ?? 0) + 1)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      this.decrement(this.rawCounts, ptyId)
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  hasRaw(ptyId: string): boolean {
    return (this.rawCounts.get(ptyId) ?? 0) > 0 || this.hasRemote(ptyId)
  }

  hasRemote(ptyId: string): boolean {
    return (this.remoteCounts.get(ptyId) ?? 0) > 0 || this.deps.hasMobileSubscribers(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.spawnPublishedPtys.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  hasPendingProviderAttach(ptyId: string): boolean {
    return this.providerAttaches.has(ptyId)
  }

  attachInventoryWaiterIds(): string[] {
    return [...this.attachInventoryWaiters]
  }

  reconcileProviderAttach(ptyId: string): void {
    if (!this.hasRemote(ptyId)) {
      return
    }
    const pending = this.providerAttaches.get(ptyId)
    if (!pending) {
      this.ensureProviderAttach(ptyId)
      return
    }
    if (this.attachInventoryWaiters.has(ptyId)) {
      return
    }
    this.attachInventoryWaiters.add(ptyId)
    void pending.then((attached) => {
      this.attachInventoryWaiters.delete(ptyId)
      if (attached || !this.hasRemote(ptyId)) {
        return
      }
      if (this.providerAttaches.get(ptyId) === pending) {
        this.providerAttaches.delete(ptyId)
      }
      this.ensureProviderAttach(ptyId)
    })
  }

  private ensureProviderAttach(ptyId: string): void {
    if (this.providerAttaches.has(ptyId) || !this.isKnownUnattachedLocal(ptyId)) {
      return
    }
    let attempt: Promise<boolean> | null
    try {
      attempt = this.deps.attachProvider(ptyId)
    } catch {
      attempt = Promise.resolve(false)
    }
    if (!attempt) {
      return
    }
    const guardedAttempt = Promise.resolve(attempt).catch(() => false)
    this.providerAttaches.set(ptyId, guardedAttempt)
    void guardedAttempt.then((attached) => {
      if (!attached && this.providerAttaches.get(ptyId) === guardedAttempt) {
        this.providerAttaches.delete(ptyId)
      }
    })
  }

  private decrement(counts: Map<string, number>, ptyId: string): void {
    const next = (counts.get(ptyId) ?? 1) - 1
    if (next <= 0) {
      counts.delete(ptyId)
    } else {
      counts.set(ptyId, next)
    }
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      release()
    }
  }
}
