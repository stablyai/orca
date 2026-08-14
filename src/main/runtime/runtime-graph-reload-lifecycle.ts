export const RUNTIME_GRAPH_RELOAD_TIMEOUT_MS = 15_000

export type RuntimeGraphReloadOutcome = 'success' | 'failure' | 'cancelled' | 'timeout'

export type RuntimeGraphReloadSettlement = Readonly<{
  revision: number
  windowId: number
  outcome: RuntimeGraphReloadOutcome
  durationMs: number
}>

type ActiveRuntimeGraphReload = Readonly<{
  revision: number
  windowId: number
  startedAt: number
  timer: ReturnType<typeof setTimeout>
}>

export class RuntimeGraphReloadLifecycle {
  private revision = 0
  private active: ActiveRuntimeGraphReload | null = null

  constructor(
    private readonly options: {
      timeoutMs: number
      onSettled?: (settlement: RuntimeGraphReloadSettlement) => void
      onTimeout?: (revision: number, windowId: number) => void
    }
  ) {}

  begin(windowId: number): number {
    const cancelled = this.active ? this.finish(this.active.revision, 'cancelled') : null

    const revision = ++this.revision
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      const settlement = this.finish(revision, 'timeout')
      if (!settlement) {
        return
      }
      this.options.onSettled?.(settlement)
      this.options.onTimeout?.(revision, windowId)
    }, this.options.timeoutMs)
    timer.unref?.()
    this.active = { revision, windowId, startedAt, timer }
    if (cancelled) {
      this.options.onSettled?.(cancelled)
    }
    return revision
  }

  settle(revision: number, outcome: RuntimeGraphReloadOutcome): boolean {
    const settlement = this.finish(revision, outcome)
    if (!settlement) {
      return false
    }
    this.options.onSettled?.(settlement)
    return true
  }

  private finish(
    revision: number,
    outcome: RuntimeGraphReloadOutcome
  ): RuntimeGraphReloadSettlement | null {
    const active = this.active
    if (!active || active.revision !== revision) {
      return null
    }

    clearTimeout(active.timer)
    this.active = null
    return {
      revision,
      windowId: active.windowId,
      outcome,
      durationMs: Math.max(0, Date.now() - active.startedAt)
    }
  }

  settleActive(outcome: RuntimeGraphReloadOutcome): boolean {
    return this.active ? this.settle(this.active.revision, outcome) : false
  }

  getActiveRevision(): number | null {
    return this.active?.revision ?? null
  }
}
