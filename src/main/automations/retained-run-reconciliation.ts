import type { AutomationRun } from '../../shared/automations-types'

const RETRY_INTERVAL_MS = 2_000
/** Allow restored panes and SSH/WSL PTYs to reattach after surface readiness. */
const SURFACE_SETTLE_MS = 2 * 60 * 1000

export type RetainedRunReconcilerDeps = {
  /** Return false until a watcher can attach. */
  attach: (run: AutomationRun) => boolean
  stillRetained: (run: AutomationRun) => boolean
  strand: (run: AutomationRun) => void
}

/** Pane lookup failures prove loss only after the surface is ready and its grace expires. */
export class RetainedRunReconciler {
  private readonly deps: RetainedRunReconcilerDeps
  private readonly pending = new Map<string, AutomationRun>()
  private timer: ReturnType<typeof setInterval> | null = null
  private surfaceReadyAt: number | null = null
  private disposed = false

  constructor(deps: RetainedRunReconcilerDeps) {
    this.deps = deps
  }

  reconcile(runs: readonly AutomationRun[]): void {
    if (this.disposed) {
      return
    }
    for (const run of runs) {
      if (!this.deps.attach(run)) {
        this.pending.set(run.id, run)
      }
    }
    this.sweep()
  }

  markSurfaceReady(): void {
    if (this.disposed) {
      return
    }
    this.surfaceReadyAt ??= Date.now()
    this.sweep()
  }

  dispose(): void {
    this.disposed = true
    this.pending.clear()
    this.disarm()
  }

  private sweep(): void {
    const strandAt = this.surfaceReadyAt === null ? null : this.surfaceReadyAt + SURFACE_SETTLE_MS
    for (const [runId, run] of this.pending) {
      if (!this.deps.stillRetained(run) || this.deps.attach(run)) {
        this.pending.delete(runId)
        continue
      }
      if (strandAt !== null && Date.now() >= strandAt) {
        this.pending.delete(runId)
        this.deps.strand(run)
      }
    }
    if (this.pending.size === 0) {
      this.disarm()
      return
    }
    this.arm()
  }

  private arm(): void {
    if (this.timer || this.disposed) {
      return
    }
    const timer = setInterval(() => this.sweep(), RETRY_INTERVAL_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.timer = timer
  }

  private disarm(): void {
    if (!this.timer) {
      return
    }
    clearInterval(this.timer)
    this.timer = null
  }
}
