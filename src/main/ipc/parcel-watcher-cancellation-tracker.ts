import type { ChildProcess } from 'node:child_process'
import { RUNTIME_FILE_WATCH_CANCEL_TIMEOUT_MS } from '../../shared/runtime-file-watch-limits'

type CancelledSubscribe = {
  child: ChildProcess
  error: Error
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

// Why: cancellation may queue behind a legitimate crawl, but must not let a
// wedged native unsubscribe block destructive worktree cleanup forever.
export const WATCHER_PROCESS_CANCEL_TIMEOUT_MS = RUNTIME_FILE_WATCH_CANCEL_TIMEOUT_MS

export class WatcherCancellationTracker {
  private readonly entries = new Map<number, CancelledSubscribe>()
  private readonly restartingChildren = new Set<ChildProcess>()

  begin(
    id: number,
    child: ChildProcess,
    error: Error,
    reject: (error: Error) => void,
    onTimeout: () => void
  ): void {
    const timer = setTimeout(onTimeout, WATCHER_PROCESS_CANCEL_TIMEOUT_MS)
    timer.unref?.()
    this.entries.set(id, { child, error, reject, timer })
  }

  has(id: number): boolean {
    return this.entries.has(id)
  }

  beginRestart(child: ChildProcess): boolean {
    if (this.restartingChildren.has(child)) {
      return false
    }
    this.restartingChildren.add(child)
    for (const cancelled of this.entries.values()) {
      if (cancelled.child === child) {
        clearTimeout(cancelled.timer)
      }
    }
    return true
  }

  finishRestart(child: ChildProcess, error?: Error): void {
    this.completeForChild(child, error)
    this.restartingChildren.delete(child)
  }

  complete(id: number, error?: Error): boolean {
    const cancelled = this.entries.get(id)
    if (!cancelled) {
      return false
    }
    this.entries.delete(id)
    clearTimeout(cancelled.timer)
    cancelled.reject(error ?? cancelled.error)
    return true
  }

  completeAll(): void {
    for (const id of this.entries.keys()) {
      this.complete(id)
    }
  }

  completeForChild(child: ChildProcess, error?: Error): void {
    for (const [id, cancelled] of this.entries) {
      if (cancelled.child === child) {
        this.complete(id, error)
      }
    }
  }
}
