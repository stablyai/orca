const MAIL_POINTER_REPOINT_DELAY_MS = 2_000

export class MailPointerRepointScheduler {
  private readonly timersByHandle = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(
    private readonly repoint: (handle: string) => void,
    private readonly delayMs = MAIL_POINTER_REPOINT_DELAY_MS
  ) {}

  schedule(handle: string): void {
    if (this.timersByHandle.has(handle)) {
      return
    }
    const timer = setTimeout(() => {
      if (this.timersByHandle.get(handle) !== timer) {
        return
      }
      this.timersByHandle.delete(handle)
      this.repoint(handle)
    }, this.delayMs)
    timer.unref?.()
    this.timersByHandle.set(handle, timer)
  }

  /** Handles still awaiting a repoint; a quiet scheduler holds none. */
  get pendingCount(): number {
    return this.timersByHandle.size
  }

  cancel(handle: string): void {
    const timer = this.timersByHandle.get(handle)
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    this.timersByHandle.delete(handle)
  }

  clear(): void {
    for (const timer of this.timersByHandle.values()) {
      clearTimeout(timer)
    }
    this.timersByHandle.clear()
  }
}
