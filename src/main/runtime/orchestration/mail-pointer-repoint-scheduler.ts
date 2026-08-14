const MAIL_POINTER_REPOINT_DELAY_MS = 2_000
// Why: restore can hold dozens of pending mailboxes, and one shared deadline collapses their
// SQLite reads into a single tick. Spread them across a bounded window instead.
const MAIL_POINTER_REPOINT_RESTORE_WINDOW_MS = 15_000
const MAIL_POINTER_REPOINT_RESTORE_STEP_MS = 250

export class MailPointerRepointScheduler {
  private readonly timersByHandle = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly repoint: (handle: string) => void) {}

  schedule(handle: string, delayMs: number = MAIL_POINTER_REPOINT_DELAY_MS): void {
    if (this.timersByHandle.has(handle)) {
      return
    }
    const timer = setTimeout(() => {
      if (this.timersByHandle.get(handle) !== timer) {
        return
      }
      this.timersByHandle.delete(handle)
      this.repoint(handle)
    }, delayMs)
    timer.unref?.()
    this.timersByHandle.set(handle, timer)
  }

  scheduleStaggered(handles: readonly string[]): void {
    const step =
      handles.length > 1
        ? Math.min(
            MAIL_POINTER_REPOINT_RESTORE_STEP_MS,
            MAIL_POINTER_REPOINT_RESTORE_WINDOW_MS / (handles.length - 1)
          )
        : 0
    handles.forEach((handle, index) => {
      this.schedule(handle, MAIL_POINTER_REPOINT_DELAY_MS + index * step)
    })
  }

  // Why: the repair only covers a pointer that never landed, so a definitive delivery retires it.
  cancel(handle: string): void {
    const timer = this.timersByHandle.get(handle)
    if (!timer) {
      return
    }
    clearTimeout(timer)
    this.timersByHandle.delete(handle)
  }

  clear(): void {
    for (const timer of this.timersByHandle.values()) {
      clearTimeout(timer)
    }
    this.timersByHandle.clear()
  }
}
