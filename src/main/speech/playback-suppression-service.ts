export type PlaybackSuppressionCapability =
  | { available: true; backend: string }
  | { available: false; reason: string }

export type PlaybackSuppressionSnapshot = {
  backend: string
  muted: boolean
}

export type PlaybackSuppressionAdapter = {
  getCapability(): Promise<PlaybackSuppressionCapability>
  snapshot(signal?: AbortSignal): Promise<PlaybackSuppressionSnapshot>
  setMuted(muted: boolean, signal?: AbortSignal): Promise<void>
}

export type PlaybackSuppressionAcquireResult =
  | { active: true }
  | { active: false; reason: 'canceled' | 'unavailable' }

export class PlaybackSuppressionService {
  private readonly owners = new Set<string>()
  private activeSnapshot: PlaybackSuppressionSnapshot | null = null
  private pendingActivation: Promise<PlaybackSuppressionAcquireResult> | null = null
  private activationController: AbortController | null = null
  private generation = 0

  constructor(private readonly adapter: PlaybackSuppressionAdapter) {}

  getCapability(): Promise<PlaybackSuppressionCapability> {
    return this.adapter.getCapability()
  }

  async acquire(owner: string): Promise<PlaybackSuppressionAcquireResult> {
    this.owners.add(owner)

    while (this.owners.has(owner)) {
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
      await this.restore(activeSnapshot)
      return
    }
    await this.pendingActivation
  }

  async releaseAll(): Promise<void> {
    this.owners.clear()
    this.generation += 1
    this.activationController?.abort()
    const activeSnapshot = this.activeSnapshot
    this.activeSnapshot = null
    if (activeSnapshot && !activeSnapshot.muted) {
      await this.restore(activeSnapshot)
      return
    }
    await this.pendingActivation
  }

  private async activate(
    generation: number,
    controller: AbortController
  ): Promise<PlaybackSuppressionAcquireResult> {
    let snapshot: PlaybackSuppressionSnapshot | null = null
    try {
      snapshot = await this.adapter.snapshot(controller.signal)
      if (!this.isCurrent(generation)) {
        return { active: false, reason: 'canceled' }
      }
      if (!snapshot.muted) {
        await this.adapter.setMuted(true, controller.signal)
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
      this.owners.clear()
      return { active: false, reason: 'unavailable' }
    }
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.owners.size > 0
  }

  private restore(snapshot: PlaybackSuppressionSnapshot): Promise<void> {
    return this.adapter.setMuted(snapshot.muted, new AbortController().signal)
  }
}
