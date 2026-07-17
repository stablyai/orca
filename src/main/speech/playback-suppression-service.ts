export type PlaybackSuppressionSnapshot = {
  backend: string
  endpointId?: string
  endpointTarget?: string
  muted: boolean
}

export type PlaybackSuppressionAdapter = {
  getCapability(): Promise<boolean>
  snapshot(signal?: AbortSignal): Promise<PlaybackSuppressionSnapshot>
  setMuted(
    muted: boolean,
    signal?: AbortSignal,
    snapshot?: PlaybackSuppressionSnapshot
  ): Promise<void>
}

export type PlaybackSuppressionAcquireResult =
  | { active: true }
  | { active: false; reason: 'canceled' | 'unavailable' }

export type PlaybackSuppressionRecoveryStore = {
  read(): Promise<PlaybackSuppressionSnapshot | null>
  write(snapshot: PlaybackSuppressionSnapshot): Promise<void>
  clear(): Promise<void>
}

export class PlaybackSuppressionService {
  private readonly owners = new Set<string>()
  private activeSnapshot: PlaybackSuppressionSnapshot | null = null
  private pendingActivation: Promise<PlaybackSuppressionAcquireResult> | null = null
  private pendingRestoration: Promise<void> | null = null
  private activationController: AbortController | null = null
  private recoveryPromise: Promise<void> | null = null
  private generation = 0

  constructor(
    private readonly adapter: PlaybackSuppressionAdapter,
    private readonly recoveryStore?: PlaybackSuppressionRecoveryStore
  ) {}

  async getCapability(): Promise<boolean> {
    await this.ensureRecovered()
    return this.adapter.getCapability()
  }

  async acquire(owner: string): Promise<PlaybackSuppressionAcquireResult> {
    this.owners.add(owner)
    await this.ensureRecovered()

    while (this.owners.has(owner)) {
      if (this.pendingRestoration) {
        await this.pendingRestoration.catch(() => undefined)
        continue
      }
      if (this.activeSnapshot) {
        return { active: true }
      }
      if (this.pendingActivation) {
        const result = await this.pendingActivation
        if (!result.active) {
          return result
        }
        if (!this.owners.has(owner)) {
          return { active: false, reason: 'canceled' }
        }
        return result
      }

      const generation = ++this.generation
      const controller = new AbortController()
      this.activationController = controller
      const activation = this.activate(generation, controller)
      this.pendingActivation = activation.finally(() => {
        this.pendingActivation = null
        if (this.activationController === controller) {
          this.activationController = null
        }
      })
      const activationWithCleanup = this.pendingActivation
      const result = await activationWithCleanup
      if (!result.active) {
        return result
      }
      if (!this.owners.has(owner)) {
        return { active: false, reason: 'canceled' }
      }
      return result
    }

    return { active: false, reason: 'canceled' }
  }

  async release(owner: string): Promise<void> {
    if (!this.owners.delete(owner) || this.owners.size > 0) {
      return
    }

    this.generation += 1
    this.activationController?.abort()
    const activeSnapshot = this.activeSnapshot
    this.activeSnapshot = null
    if (activeSnapshot && !activeSnapshot.muted) {
      const restoration = this.restore(activeSnapshot).catch((error: unknown) => {
        this.activeSnapshot = activeSnapshot
        throw error
      })
      this.pendingRestoration = restoration
      try {
        await restoration
      } finally {
        if (this.pendingRestoration === restoration) {
          this.pendingRestoration = null
        }
      }
      return
    }
    await this.pendingActivation
  }

  private async activate(
    generation: number,
    controller: AbortController
  ): Promise<PlaybackSuppressionAcquireResult> {
    let snapshot: PlaybackSuppressionSnapshot | null = null
    let recoveryWritten = false
    try {
      snapshot = await this.adapter.snapshot(controller.signal)
      if (!this.isCurrent(generation)) {
        return { active: false, reason: 'canceled' }
      }
      if (!snapshot.muted) {
        if (this.recoveryStore && (!snapshot.endpointId || !snapshot.endpointTarget)) {
          throw new Error('Playback endpoint cannot be restored safely.')
        }
        await this.recoveryStore?.write(snapshot)
        recoveryWritten = Boolean(this.recoveryStore)
        await this.adapter.setMuted(true, controller.signal, snapshot)
      }
      if (!this.isCurrent(generation)) {
        if (!snapshot.muted) {
          await this.restore(snapshot)
        }
        return { active: false, reason: 'canceled' }
      }
      this.activeSnapshot = snapshot
      return { active: true }
    } catch {
      if (snapshot && recoveryWritten) {
        await this.reconcileFailedActivation(snapshot)
      }
      this.owners.clear()
      return { active: false, reason: 'unavailable' }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.owners.size > 0
  }

  private async restore(snapshot: PlaybackSuppressionSnapshot): Promise<void> {
    await this.adapter.setMuted(snapshot.muted, new AbortController().signal, snapshot)
    await this.recoveryStore?.clear()
  }

  private ensureRecovered(): Promise<void> {
    if (!this.recoveryStore) {
      return Promise.resolve()
    }
    if (!this.recoveryPromise) {
      this.recoveryPromise = this.recoverStrandedMute()
    }
    return this.recoveryPromise
  }

  private async recoverStrandedMute(): Promise<void> {
    const marker = await this.recoveryStore?.read()
    if (!marker || !this.recoveryStore) {
      return
    }
    try {
      const current = await this.adapter.snapshot()
      const sameEndpoint =
        Boolean(marker.endpointId) &&
        marker.backend === current.backend &&
        marker.endpointId === current.endpointId
      if (!sameEndpoint) {
        // Why: the marker is the only durable path to restore the captured endpoint later.
        return
      }
      if (current.muted) {
        await this.adapter.setMuted(marker.muted, new AbortController().signal, current)
      }
      await this.recoveryStore.clear()
    } catch {
      // Keep the marker so a later launch can retry recovery safely.
    }
  }

  private async reconcileFailedActivation(snapshot: PlaybackSuppressionSnapshot): Promise<void> {
    if (!this.recoveryStore) {
      return
    }
    try {
      const current = await this.adapter.snapshot()
      const sameEndpoint =
        snapshot.backend === current.backend && snapshot.endpointId === current.endpointId
      if (!sameEndpoint) {
        // Why: clearing here can strand the captured endpoint in a muted state.
        return
      }
      if (current.muted !== snapshot.muted) {
        await this.adapter.setMuted(snapshot.muted, new AbortController().signal, current)
      }
      await this.recoveryStore.clear()
    } catch {
      // Preserve the marker when the current state cannot be proven safe.
    }
  }
}
