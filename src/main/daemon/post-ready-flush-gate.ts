/**
 * Defers a flush callback until after the shell has drawn its prompt and
 * switched the PTY into raw mode.
 *
 * Why: the OSC 777 shell-ready marker fires from zsh's precmd_functions /
 * bash's PROMPT_COMMAND — before the shell draws its prompt and before
 * zle/readline flips the PTY into raw mode. Flushing queued input then lets
 * the kernel (ECHO still on) echo the command once, and the line editor
 * redraws it under the prompt — producing a visible duplicate (e.g. "claude"
 * appears twice on agent launch).
 *
 * Strategy: after arm() is called, wait for the next PTY data chunk (the
 * prompt draw) plus a short delay for the tcsetattr() that enables raw mode.
 * A wall-clock fallback covers the case where the prompt arrives in the same
 * chunk as the marker, so no follow-up notifyData() ever fires.
 *
 * Mirrors the gate in local-pty-shell-ready.ts::writeStartupCommandWhenShellReady,
 * which solves the same race on the non-daemon path.
 */

export const POST_READY_FLUSH_DELAY_MS = 30
export const POST_READY_FLUSH_FALLBACK_MS = 50

export class PostReadyFlushGate {
  private awaitingPromptDraw = false
  private postDataTimer: ReturnType<typeof setTimeout> | null = null
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onFlush: () => void) {}

  /** True between arm() and the actual flush firing. Callers should treat
   *  input as still-queued during this window to preserve ordering. */
  get isPending(): boolean {
    return this.awaitingPromptDraw || this.postDataTimer !== null || this.fallbackTimer !== null
  }

  /** Arm the gate after observing the shell-ready marker. Starts the
   *  wall-clock fallback; the flush fires when the fallback elapses or when
   *  notifyData() observes a subsequent PTY data chunk. */
  arm(): void {
    this.awaitingPromptDraw = true
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null
      this.awaitingPromptDraw = false
      this.onFlush()
    }, POST_READY_FLUSH_FALLBACK_MS)
  }

  /** Report a PTY data chunk observed after arm(). The first such call swaps
   *  the wall-clock fallback for the short post-data delay so readline has
   *  time to enable raw mode before the flush fires. */
  notifyData(): void {
    if (!this.awaitingPromptDraw) {
      return
    }
    this.awaitingPromptDraw = false
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
    if (this.postDataTimer === null) {
      this.postDataTimer = setTimeout(() => {
        this.postDataTimer = null
        this.onFlush()
      }, POST_READY_FLUSH_DELAY_MS)
    }
  }

  /** Cancel any pending flush. Call on session teardown. */
  clear(): void {
    this.awaitingPromptDraw = false
    if (this.postDataTimer) {
      clearTimeout(this.postDataTimer)
      this.postDataTimer = null
    }
    if (this.fallbackTimer) {
      clearTimeout(this.fallbackTimer)
      this.fallbackTimer = null
    }
  }
}
