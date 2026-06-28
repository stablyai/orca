const DEFAULT_WINDOW_MS = 600

/** Detects a double-Esc used to leave terminal focus on keyboards without a
 *  Ctrl-] key (most mobile bars). A single lone Esc returns false so it still
 *  reaches the PTY; two within the window — or "\x1b\x1b" in one read — return
 *  true. Stateful, so one instance per controller. */
export class DoubleEscapeDetector {
  private lastEscAt = 0

  constructor(private readonly windowMs: number = DEFAULT_WINDOW_MS) {}

  test(data: string, now: number): boolean {
    if (data === '\x1b\x1b') {
      this.lastEscAt = 0
      return true
    }
    if (data !== '\x1b') {
      // Any other input breaks the streak, so only two *consecutive* Escs exit.
      this.lastEscAt = 0
      return false
    }
    if (now - this.lastEscAt < this.windowMs) {
      this.lastEscAt = 0
      return true
    }
    this.lastEscAt = now
    return false
  }
}
