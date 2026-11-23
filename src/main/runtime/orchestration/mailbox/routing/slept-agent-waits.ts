import type { TerminalHandleTouches } from '../../../terminal/identity/terminal-handle-touches'

/** Pending slept-agent waits by handle and by pane leaf: identity writes and dropped leaves
 *  re-check only the waits they name, and nothing listens once none are pending. */
export class SleptAgentWaits {
  private readonly byHandle = new Map<string, Set<() => void>>()
  private readonly handlesByLeaf = new Map<string, Set<string>>()
  private touched: Set<string> | 'all' | null = null
  private rechecking = false
  private stopWatching: (() => void) | null = null

  constructor(private readonly touches: () => TerminalHandleTouches) {}

  get size(): number {
    return this.byHandle.size
  }

  add(handle: string, leafId: string | null, check: () => void): void {
    this.byHandle.set(handle, (this.byHandle.get(handle) ?? new Set()).add(check))
    if (leafId !== null) {
      this.handlesByLeaf.set(leafId, (this.handlesByLeaf.get(leafId) ?? new Set()).add(handle))
    }
    this.stopWatching ??= this.touches().listen(
      (touched) => this.queue(touched),
      (dropped) => {
        for (const waited of this.handlesByLeaf.get(dropped) ?? []) {
          this.queue(waited)
        }
      }
    )
  }

  remove(handle: string, leafId: string | null, check: () => void): void {
    const checks = this.byHandle.get(handle)
    checks?.delete(check)
    if (checks?.size !== 0) {
      return
    }
    this.byHandle.delete(handle)
    const handles = leafId === null ? undefined : this.handlesByLeaf.get(leafId)
    handles?.delete(handle)
    if (leafId !== null && handles?.size === 0) {
      this.handlesByLeaf.delete(leafId)
    }
    // A timed-out or cancelled last wait stops listening too, not only one a re-check settles.
    this.stopWatchingWhenIdle()
  }

  recheck(handles: Iterable<string> | 'all'): void {
    // A check can restore a slept name, which touches its handle again.
    if (this.rechecking) {
      return
    }
    this.rechecking = true
    try {
      for (const handle of handles === 'all' ? this.byHandle.keys() : handles) {
        for (const check of this.byHandle.get(handle) ?? []) {
          check()
        }
      }
    } finally {
      this.rechecking = false
    }
    this.stopWatchingWhenIdle()
  }

  private stopWatchingWhenIdle(): void {
    if (this.byHandle.size === 0) {
      this.stopWatching?.()
      this.stopWatching = null
    }
  }

  // Deferred: identity writes land mid-sync, before the graph's leaves and handles agree.
  private queue(handle: string | null): void {
    if (this.rechecking || this.touched === 'all') {
      return
    }
    if (handle !== null && !this.byHandle.has(handle)) {
      return
    }
    const queued = this.touched !== null
    this.touched = handle === null ? 'all' : (this.touched ?? new Set<string>()).add(handle)
    if (!queued) {
      queueMicrotask(() => {
        const touched = this.touched
        this.touched = null
        if (touched) {
          this.recheck(touched)
        }
      })
    }
  }
}
