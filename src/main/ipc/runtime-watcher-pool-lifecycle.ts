import { WatcherProcessFailure } from './parcel-watcher-process-failure'

export class RuntimeWatcherPoolLifecycle {
  readonly isolatedRoots = new Set<string>()
  readonly failedQuarantineRoots = new Set<string>()
  private disposed = false

  assertActive(): void {
    if (this.disposed) {
      throw new WatcherProcessFailure(
        'file watcher supervisor disposed',
        'supervisor',
        'supervisor_disposed'
      )
    }
  }

  isIsolated(root: string): boolean {
    return this.isolatedRoots.has(root)
  }

  quarantineOrFuse(root: string, isolated: boolean): void {
    // Why: one quarantine attempt is the recovery budget; a second failure is fused.
    if (isolated) {
      this.isolatedRoots.delete(root)
      this.failedQuarantineRoots.add(root)
      return
    }
    this.isolatedRoots.add(root)
  }

  dispose(): void {
    this.disposed = true
    this.isolatedRoots.clear()
    this.failedQuarantineRoots.clear()
  }

  reset(): void {
    this.disposed = false
  }
}
