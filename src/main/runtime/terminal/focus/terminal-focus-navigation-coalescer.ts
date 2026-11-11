/** Only one host terminal can own focus; serialize navigation and collapse pending jobs to newest to avoid freezing large remote fleets.
 * In-flight jobs recheck generation before claiming navigation; activation and reconnect bounds remain separate. */

export type TerminalFocusNavigationContext = {
  /** True while this job is still the newest focus request. */
  isCurrent: () => boolean
}

export type TerminalFocusNavigationJob<TResult> = {
  /** Stable key for diagnostics (usually terminal handle). */
  key: string
  /** Recheck ctx.isCurrent around expensive host work; obsolete jobs must not claim navigation. */
  run: (ctx: TerminalFocusNavigationContext) => Promise<TResult>
  /** Superseded results must not navigate and should report navigated: false. */
  resolveSuperseded: (completed?: TResult) => TResult
}

type PendingJob<TResult> = {
  key: string
  generation: number
  run: (ctx: TerminalFocusNavigationContext) => Promise<TResult>
  resolve: (value: TResult) => void
  reject: (error: unknown) => void
  resolveSuperseded: (completed?: TResult) => TResult
}

export class TerminalFocusNavigationCoalescer<TResult> {
  private running = false
  private pending: PendingJob<TResult> | null = null
  private activeKey: string | null = null
  private generation = 0

  getState(): {
    running: boolean
    activeKey: string | null
    pendingKey: string | null
    generation: number
  } {
    return {
      running: this.running,
      activeKey: this.activeKey,
      pendingKey: this.pending?.key ?? null,
      generation: this.generation
    }
  }

  run(job: TerminalFocusNavigationJob<TResult>): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (this.pending) {
        try {
          this.pending.resolve(this.pending.resolveSuperseded())
        } catch (error) {
          this.pending.reject(error)
        }
      }
      const generation = ++this.generation
      this.pending = {
        key: job.key,
        generation,
        run: job.run,
        resolve,
        reject,
        resolveSuperseded: job.resolveSuperseded
      }
      void this.pump()
    })
  }

  private async pump(): Promise<void> {
    if (this.running) {
      return
    }
    this.running = true
    try {
      while (this.pending) {
        const job = this.pending
        this.pending = null
        this.activeKey = job.key
        const ctx: TerminalFocusNavigationContext = {
          isCurrent: () => job.generation === this.generation
        }
        try {
          if (!ctx.isCurrent()) {
            job.resolve(job.resolveSuperseded())
            continue
          }
          const result = await job.run(ctx)
          job.resolve(ctx.isCurrent() ? result : job.resolveSuperseded(result))
        } catch (error) {
          if (ctx.isCurrent()) {
            job.reject(error)
          } else {
            try {
              job.resolve(job.resolveSuperseded())
            } catch (supersedeError) {
              job.reject(supersedeError)
            }
          }
        } finally {
          this.activeKey = null
        }
      }
    } finally {
      this.running = false
      if (this.pending) {
        void this.pump()
      }
    }
  }
}
