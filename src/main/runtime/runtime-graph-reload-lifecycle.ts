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
    if (this.active) {
      this.settle(this.active.revision, 'cancelled')
    }

    const revision = ++this.revision
    const startedAt = Date.now()
    const timer = setTimeout(() => {
      if (!this.settle(revision, 'timeout')) {
        return
      }
      this.options.onTimeout?.(revision, windowId)
    }, this.options.timeoutMs)
    timer.unref?.()
    this.active = { revision, windowId, startedAt, timer }
    return revision
  }

  settle(revision: number, outcome: RuntimeGraphReloadOutcome): boolean {
    const active = this.active
    if (!active || active.revision !== revision) {
      return false
    }

    clearTimeout(active.timer)
    this.active = null
    this.options.onSettled?.({
      revision,
      windowId: active.windowId,
      outcome,
      durationMs: Math.max(0, Date.now() - active.startedAt)
    })
    return true
  }

  settleActive(outcome: RuntimeGraphReloadOutcome): boolean {
    return this.active ? this.settle(this.active.revision, outcome) : false
  }

  getActiveRevision(): number | null {
    return this.active?.revision ?? null
  }
}
