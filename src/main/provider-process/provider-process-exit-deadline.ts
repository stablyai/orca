export async function waitForProcessExitUntil(
  exitPromise: Promise<void>,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    await Promise.race([exitPromise, timeout])
  } finally {
    // Why: this runs in a short-lived entry; a live grace timer delays the
    // parent spawnSync even after the provider process has already exited.
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

/** One deadline follows a recovery action through queueing, reads and signals. */
export class ProviderCleanupBudget {
  readonly signal: AbortSignal
  constructor(
    readonly deadline = Date.now() + 6_500,
    lifetime?: AbortSignal
  ) {
    const timeout = AbortSignal.timeout(Math.max(1, this.remaining()))
    this.signal = lifetime ? AbortSignal.any([timeout, lifetime]) : timeout
  }
  remaining(): number {
    return Math.max(0, this.deadline - Date.now())
  }
  get active(): boolean {
    return !this.signal.aborted && this.remaining() > 0
  }
  async wait<T>(work: Promise<T>, unknown: T): Promise<T> {
    if (!this.active) {
      return unknown
    }
    let expired = (): void => {}
    const timeout = new Promise<T>((resolve) => {
      expired = () => resolve(unknown)
      this.signal.addEventListener('abort', expired, { once: true })
    })
    try {
      return await Promise.race([work, timeout])
    } finally {
      this.signal.removeEventListener('abort', expired)
    }
  }
}
