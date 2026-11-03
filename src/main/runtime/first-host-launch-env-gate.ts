/**
 * A fresh WSL host has no account env until its desktop's first push, which can land a fraction of
 * a second after orcad starts. Agent launches in that window wait for it, once and briefly, rather
 * than start on the distro's own login.
 */

/** How long a WSL host's first agent launch waits for the desktop's first account push. */
export const FIRST_HOST_LAUNCH_ENV_WAIT_MS = 5_000

export class FirstHostLaunchEnvGate {
  private pending: { promise: Promise<void>; settle: () => void } | null = null

  get armed(): boolean {
    return this.pending !== null
  }

  arm(): void {
    if (this.pending) {
      return
    }
    let settle: () => void = () => {}
    const promise = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.pending = { promise, settle }
  }

  settle(): void {
    const pending = this.pending
    this.pending = null
    pending?.settle()
  }

  /** Resolves once the push lands, or after `timeoutMs`; later waits return at once either way. */
  async wait(timeoutMs: number = FIRST_HOST_LAUNCH_ENV_WAIT_MS): Promise<void> {
    const pending = this.pending
    if (!pending) {
      return
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = await Promise.race([
      pending.promise.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), timeoutMs)
      })
    ])
    clearTimeout(timer)
    if (timedOut && this.pending === pending) {
      console.warn(
        "[accounts] The desktop has not sent this host's accounts yet; launching on the distro's own login."
      )
      this.settle()
    }
  }
}
