type MainDaemonAttachmentDependencies = {
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
  hasRemoteView: (ptyId: string) => boolean
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
  // Endpoint losses per session since main last re-attached it; present while a re-attach is owed.
  private readonly endpointLosses = new Map<string, number>()

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.attached.add(ptyId)
  }

  /** Exit or respawn ends the generation whose stream this described. */
  forget(ptyId: string): void {
    this.attached.delete(ptyId)
    this.attaching.delete(ptyId)
    this.endpointLosses.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.attached.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  /** A daemon reconnect drops main's attachment, and with it the session's output and input; only a pane
   *  in this window re-attaches on its own, so main re-attaches the ones remote views show or input targets. */
  noteEndpointLoss(ptyId: string): void {
    this.endpointLosses.set(ptyId, (this.endpointLosses.get(ptyId) ?? 0) + 1)
    this.attached.delete(ptyId)
    this.ensure(ptyId)
  }

  /** Input for a session an endpoint loss detached re-attaches it first; null when no re-attach is owed. */
  reattachForInput(ptyId: string): Promise<void> | null {
    if (!this.endpointLosses.has(ptyId)) {
      return null
    }
    const attempt = this.attaching.get(ptyId) ?? this.start(ptyId)
    return attempt.then(() => undefined)
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
    if (this.attaching.has(ptyId)) {
      return
    }
    const owed = this.endpointLosses.has(ptyId)
      ? this.deps.hasRemoteView(ptyId)
      : this.isKnownUnattachedLocal(ptyId)
    if (owed) {
      this.start(ptyId)
    }
  }

  private start(ptyId: string): Promise<boolean> {
    const lossCount = this.endpointLosses.get(ptyId)
    const attempt: Promise<boolean> = this.acquireSlot().then(() => this.attach(ptyId, attempt))
    this.attaching.set(ptyId, attempt)
    void attempt.then((attached) => {
      if (this.attaching.get(ptyId) !== attempt) {
        return
      }
      this.attaching.delete(ptyId)
      // A loss during the attempt can undo an attach made just before it.
      if (this.endpointLosses.get(ptyId) !== lossCount) {
        this.ensure(ptyId)
        return
      }
      if (attached) {
        this.attached.add(ptyId)
        this.endpointLosses.delete(ptyId)
      }
    })
    return attempt
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
      if (
        this.attaching.get(ptyId) !== attempt ||
        !(this.endpointLosses.has(ptyId) || this.isKnownUnattachedLocal(ptyId))
      ) {
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
