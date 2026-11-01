type MainDaemonAttachmentDependencies = {
  isUnattachedLocalCandidate: (ptyId: string) => boolean
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

  constructor(private readonly deps: MainDaemonAttachmentDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.attached.add(ptyId)
  }

  /** Exit or respawn ends the generation whose stream this described. */
  forget(ptyId: string): void {
    this.attached.delete(ptyId)
    this.attaching.delete(ptyId)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.attached.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
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
    if (this.attaching.has(ptyId) || !this.isKnownUnattachedLocal(ptyId)) {
      return
    }
    const attempt: Promise<boolean> = this.acquireSlot().then(() => this.attach(ptyId, attempt))
    this.attaching.set(ptyId, attempt)
    void attempt.then((attached) => {
      if (this.attaching.get(ptyId) !== attempt) {
        return
      }
      this.attaching.delete(ptyId)
      if (attached) {
        this.attached.add(ptyId)
      }
    })
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
      if (this.attaching.get(ptyId) !== attempt || !this.isKnownUnattachedLocal(ptyId)) {
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
