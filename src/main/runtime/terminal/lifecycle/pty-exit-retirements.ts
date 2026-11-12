import type { PtyLivenessVerdict } from '../../../../shared/terminal/pty/lifecycle/pty-liveness-verdict'
import type { TerminalExitCause } from '../../../../shared/terminal/pty/lifecycle/terminal-exit-cause'

export type PtyExitOptions = {
  hostExitConfirmed?: boolean
  cause?: TerminalExitCause
  /** Physical provider exit differs from hostExitConfirmed: node-pty may report a real exit as -1. */
  providerExitObserved?: boolean
  viewShown?: boolean
  hostLost?: boolean
}

/** Keep only in-flight retirement; the runtime's liveness verdict remains the exit authority. */
export class PtyExitRetirements {
  private readonly pending = new Map<
    string,
    { incarnationId: string | undefined; completion: Promise<boolean> }
  >()

  wait(
    id: string,
    incarnationId: string | undefined,
    verdict: PtyLivenessVerdict | null
  ): Promise<boolean> {
    const entry = this.pending.get(id)
    return entry
      ? entry.incarnationId === incarnationId
        ? entry.completion
        : Promise.resolve(false)
      : Promise.resolve(verdict?.status === 'exited' && verdict.incarnationId === incarnationId)
  }

  track(
    id: string,
    incarnationId: string | undefined,
    run: () => void | Promise<void>
  ): void | Promise<void> {
    let settle!: (success: boolean) => void
    const entry = {
      incarnationId,
      completion: new Promise<boolean>((resolve) => {
        settle = resolve
      })
    }
    const previous = this.pending.get(id)
    if (previous && previous.incarnationId === incarnationId) {
      const own = entry.completion
      entry.completion = Promise.all([previous.completion, own]).then((results) =>
        results.every(Boolean)
      )
    }
    this.pending.set(id, entry)
    void entry.completion.then(() => {
      if (this.pending.get(id) === entry) {
        this.pending.delete(id)
      }
    })
    try {
      const retirement = run()
      if (retirement) {
        const timer = setTimeout(() => settle(false), 10_000)
        timer.unref?.()
        void retirement.then(
          () => {
            clearTimeout(timer)
            settle(true)
          },
          () => {
            clearTimeout(timer)
            settle(false)
          }
        )
      } else {
        settle(true)
      }
      return retirement
    } catch (error) {
      settle(false)
      throw error
    }
  }
}
