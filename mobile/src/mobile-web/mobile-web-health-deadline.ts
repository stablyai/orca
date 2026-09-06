export class MobileWebHealthDeadline {
  private sessionId: string | undefined
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly timeoutMs: number) {}

  arm(sessionId: string, onExpired: (sessionId: string) => void): void {
    this.clear()
    this.sessionId = sessionId
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.sessionId = undefined
      onExpired(sessionId)
    }, this.timeoutMs)
  }

  acknowledge(sessionId: string): void {
    if (this.sessionId === sessionId) {
      this.clear()
    }
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer)
    }
    this.timer = undefined
    this.sessionId = undefined
  }
}
