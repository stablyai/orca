// Long enough for a desktop renderer to reattach its terminals; well inside the CLI's 60 s request timeout.
export const STARTUP_IDENTITY_WAIT_MS = 30_000
// A host whose restore never reports back (no window, renderer crash) stops holding callers.
const STARTUP_RESTORE_CAP_MS = 120_000

/**
 * The first restore of worker terminal authority after Orca starts. Until it finishes, a terminal's
 * pane and process read as unknown, which must not be scored as a changed worker identity.
 */
export class StartupWorkerAuthorityRestore {
  private started = false
  private pending: { done: Promise<void>; finish: () => void } | null = null

  begin(): void {
    if (this.started) {
      return
    }
    this.started = true
    let resolve!: () => void
    const done = new Promise<void>((r) => {
      resolve = r
    })
    const cap = setTimeout(() => this.finish(), STARTUP_RESTORE_CAP_MS)
    cap.unref?.()
    this.pending = {
      done,
      finish: () => {
        clearTimeout(cap)
        resolve()
      }
    }
  }

  finish(): void {
    this.pending?.finish()
    this.pending = null
  }

  isPending(): boolean {
    return this.pending !== null
  }

  /** Resolves when restored or after the bound, whichever is first; rejects if a signal aborts. */
  async wait(
    signals: readonly (AbortSignal | undefined)[],
    timeoutMs = STARTUP_IDENTITY_WAIT_MS
  ): Promise<void> {
    const pending = this.pending
    if (!pending) {
      return
    }
    const live = signals.filter((signal): signal is AbortSignal => signal !== undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanups: (() => void)[] = []
    const bounded = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs)
      for (const signal of live) {
        if (signal.aborted) {
          reject(new Error('runtime_unavailable'))
        }
        const onAbort = (): void => reject(new Error('runtime_unavailable'))
        signal.addEventListener('abort', onAbort, { once: true })
        cleanups.push(() => signal.removeEventListener('abort', onAbort))
      }
    })
    try {
      await Promise.race([pending.done, bounded])
    } finally {
      clearTimeout(timer)
      for (const cleanup of cleanups) {
        cleanup()
      }
    }
  }
}
