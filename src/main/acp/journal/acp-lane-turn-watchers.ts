export class AcpLaneTurnWatchers {
  private readonly watchers = new Set<(opened: boolean) => void>()
  private lastTurnId: string | null = null
  private closed = false

  constructor(private readonly openTurnId: () => string | null) {}

  onOpened(notify: () => void): void {
    this.watchers.add((opened) => {
      if (opened) {
        // A synchronous opening can precede the prompt write that owns it.
        queueMicrotask(notify)
      }
    })
  }

  whenLeaves(turnId: string, signal?: AbortSignal): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    const check = (): void => {
      if (this.closed || signal?.aborted || this.openTurnId() !== turnId) {
        this.watchers.delete(check)
        signal?.removeEventListener('abort', check)
        resolve()
      }
    }
    this.watchers.add(check)
    signal?.addEventListener('abort', check, { once: true })
    check()
    return promise
  }

  notify(): void {
    if (this.watchers.size === 0) {
      return
    }
    const turnId = this.openTurnId()
    const opened = turnId !== null && turnId !== this.lastTurnId
    this.lastTurnId = turnId
    for (const check of this.watchers) {
      check(opened)
    }
  }

  close(): void {
    this.closed = true
    for (const check of this.watchers) {
      check(false)
    }
    this.watchers.clear()
  }
}
