/** Pausing retains admission and failure deadlines; only a runtime restart starts fresh. */
export class WorkerQuietWatch {
  private timer: ReturnType<typeof setTimeout> | undefined
  private deadline: number | undefined
  private failures = 0
  private running = false
  private detach: (() => void) | undefined

  constructor(
    private readonly deps: {
      sweep: () => boolean
      subscribe: (wake: () => void) => () => void
    }
  ) {}

  start(): void {
    this.detach = this.deps.subscribe(this.wake)
    this.wake()
  }

  pause(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.detach?.()
    this.detach = undefined
  }

  private readonly wake = (): void => {
    if (this.detach && !this.running && this.timer === undefined) {
      this.timer = setTimeout(this.run, Math.max(0, (this.deadline ?? 0) - performance.now()))
      this.timer.unref?.()
    }
  }

  private readonly run = (): void => {
    this.timer = undefined
    if (!this.detach) {
      return
    }
    this.deadline = performance.now() + 60_000
    this.running = true
    let active = true
    try {
      active = this.deps.sweep()
      this.failures = 0
    } catch (error) {
      this.failures++
      this.deadline =
        performance.now() + Math.min(900_000, 60_000 * 2 ** Math.min(this.failures, 4))
      console.warn('[orchestration] quiet worker sweep failed', error)
    } finally {
      this.running = false
    }
    if (active) {
      this.wake()
    }
  }
}

export function startWorkerQuietWatch(
  deps: ConstructorParameters<typeof WorkerQuietWatch>[0]
): () => void {
  const watch = new WorkerQuietWatch(deps)
  watch.start()
  return () => watch.pause()
}
