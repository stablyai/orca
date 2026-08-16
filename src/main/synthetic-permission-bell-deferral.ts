import { CODEX_ATTENTION_QUIET_MS } from '../shared/codex-attention-quiet-window'

/**
 * Holds back the BEL that main fabricates for a Codex permission pause until the quiet window
 * elapses, so an "Approve for me" pause Codex resolves itself never rings the terminal bell
 * (#13600). The OSC title still lands immediately — only the attention signal waits.
 *
 * Cancellation is the whole point: any later non-permission state for the pane drops the pending
 * BEL, and a re-armed pause replaces its predecessor rather than queueing a second ring.
 */
export class SyntheticPermissionBellDeferral {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly quietMs: number = CODEX_ATTENTION_QUIET_MS) {}

  /** Arm (or re-arm) the deferred BEL for `paneKey`; `emit` runs only if the window elapses uncancelled. */
  defer(paneKey: string, emit: () => void): void {
    this.cancel(paneKey)
    const timer = setTimeout(() => {
      this.timers.delete(paneKey)
      emit()
    }, this.quietMs)
    // Why: a pending decorative bell must never hold the app open at quit.
    timer.unref?.()
    this.timers.set(paneKey, timer)
  }

  cancel(paneKey: string): boolean {
    const timer = this.timers.get(paneKey)
    if (timer === undefined) {
      return false
    }
    clearTimeout(timer)
    this.timers.delete(paneKey)
    return true
  }

  cancelAll(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }

  hasPending(paneKey: string): boolean {
    return this.timers.has(paneKey)
  }
}
