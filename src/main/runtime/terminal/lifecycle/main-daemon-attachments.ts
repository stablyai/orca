type MainDaemonAttachmentDependencies = {
  /** A live local daemon session main may attach now (no spawn admission in flight). */
  isAttachableLocalSession: (ptyId: string) => boolean
  /** Main already holds this session's screen, so an attach began before this run's tracking. */
  hasMainTerminalState: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

// Why capped: 100 concurrent snapshot attaches delayed the visible terminal's first echo by ~0.7 s.
const MAX_CONCURRENT_ATTACHES = 4

/** Main holds the stream for every live local daemon session it adopts, so its records fill without a mounted pane. */
export class MainDaemonAttachments {
  // Sessions whose stream this run already holds: spawned, pane-attached or main-attached.
  private readonly attached = new Set<string>()
  private readonly attaching = new Map<string, Promise<boolean>>()
  private readonly queued: (() => void)[] = []
  private running = 0
  // Endpoint losses per session while main owes it a re-attach; a count so a loss mid-attach is noticed.
  private readonly endpointLosses = new Map<string, number>()

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.attached.add(ptyId)
    this.endpointLosses.delete(ptyId)
  }

  /** Exit or respawn ends the generation whose stream this described. */
  forget(ptyId: string): void {
    this.attached.delete(ptyId)
    this.attaching.delete(ptyId)
    this.endpointLosses.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return (
      !this.attached.has(ptyId) &&
      this.deps.isAttachableLocalSession(ptyId) &&
      !this.deps.hasMainTerminalState(ptyId)
    )
  }

  /** The daemon dropped this run's attachment, so main re-attaches like at adoption; a mounted pane alone would leave background sessions silent. */
  noteEndpointLoss(ptyId: string): void {
    this.endpointLosses.set(ptyId, (this.endpointLosses.get(ptyId) ?? 0) + 1)
    this.attached.delete(ptyId)
    this.ensure(ptyId)
  }

  /** Main's re-attach after an endpoint loss, while in flight; input waits on it instead of being refused. */
  pendingReattach(ptyId: string): Promise<boolean> | undefined {
    return this.endpointLosses.has(ptyId) ? this.attaching.get(ptyId) : undefined
  }

  /** Inventory proved the session live; attach it, or retry once an in-flight refusal settles. */
  reconcile(ptyId: string): void {
    const attempt = this.attaching.get(ptyId)
    if (!attempt) {
      this.ensure(ptyId)
      return
    }
    void attempt.then((attached) => {
      if (!attached) {
        this.ensure(ptyId)
      }
    })
  }

  ensure(ptyId: string): void {
    if (this.attaching.has(ptyId) || !this.isAttachOwed(ptyId)) {
      return
    }
    const lossCount = this.endpointLosses.get(ptyId)
    const attempt: Promise<boolean> = this.acquireSlot().then(() => this.attach(ptyId, attempt))
    this.attaching.set(ptyId, attempt)
    void attempt.then((attached) => {
      if (this.attaching.get(ptyId) !== attempt) {
        return
      }
      this.attaching.delete(ptyId)
      if (this.endpointLosses.get(ptyId) !== lossCount) {
        // A loss during the attempt can undo the attach it made.
        this.ensure(ptyId)
        return
      }
      if (attached) {
        this.attached.add(ptyId)
        this.endpointLosses.delete(ptyId)
      }
    })
  }

  // A lost session needs its stream back even though main still holds its screen.
  private isAttachOwed(ptyId: string): boolean {
    return this.endpointLosses.has(ptyId)
      ? !this.attached.has(ptyId) && this.deps.isAttachableLocalSession(ptyId)
      : this.isKnownUnattachedLocal(ptyId)
  }

  private acquireSlot(): Promise<void> {
    if (this.running < MAX_CONCURRENT_ATTACHES) {
      this.running += 1
      return Promise.resolve()
    }
    // The finishing attach hands its slot over without releasing it.
    return new Promise<void>((resolve) => this.queued.push(resolve))
  }

  private async attach(ptyId: string, attempt: Promise<boolean>): Promise<boolean> {
    try {
      // While this queued, an exit or respawn may have superseded it, or a pane may have attached.
      if (this.attaching.get(ptyId) !== attempt || !this.isAttachOwed(ptyId)) {
        return false
      }
      return (await this.deps.attachProvider(ptyId)) ?? false
    } catch {
      return false
    } finally {
      const next = this.queued.shift()
      if (next) {
        next()
      } else {
        this.running -= 1
      }
    }
  }
}
