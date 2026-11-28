// Three strikes, counted separately for helpers that never start and started helpers that hang or die.
const MAX_STRIKES = 3
const MAX_RETRY_DELAY = 60_000
// A strike over an hour after the previous one starts a fresh count: rare stalls over days shouldn't turn the icon off.
const STRIKE_WINDOW = 60 * 60_000

export type MenuBarRestart = number | 'fallback' | 'off'

/** Back-off for replacing a helper, and when to stop trying. */
export class MenuBarRestartPolicy {
  private neverStarted = 0
  private diedAfterStart = 0
  private delay = 1_000
  private lastStrikeAt = -Infinity

  /**
   * Delay before the next helper; 'fallback' when the helper can't start at all (in-process is safe),
   * 'off' when started helpers keep hanging or dying (the in-process icon would hang main the same way).
   */
  next(reachedReady: boolean, livedMs: number, hung = false): MenuBarRestart {
    if (!reachedReady) {
      this.neverStarted++
      if (this.neverStarted >= MAX_STRIKES) {
        return 'fallback'
      }
    } else if (hung || livedMs < MAX_RETRY_DELAY) {
      // A hang counts however long the helper lived: the scene deadlock can strike at any update.
      // Monotonic, so clock changes can't clear or chain strikes; time asleep doesn't count, which errs toward off.
      const now = performance.now()
      if (now - this.lastStrikeAt > STRIKE_WINDOW) {
        this.diedAfterStart = 0
        this.delay = 1_000
      }
      this.lastStrikeAt = now
      this.neverStarted = 0
      this.diedAfterStart++
      if (this.diedAfterStart >= MAX_STRIKES) {
        return 'off'
      }
    } else {
      this.neverStarted = 0
      this.diedAfterStart = 0
      this.delay = 1_000
    }
    const delay = this.delay
    this.delay = Math.min(this.delay * 2, MAX_RETRY_DELAY)
    return delay
  }
}
