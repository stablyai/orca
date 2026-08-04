type QueuedTask<T> = {
  key: string | null
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

export class FilesystemHostBackgroundQueue {
  private active = 0
  private disposed = false
  private readonly pending: QueuedTask<unknown>[] = []

  constructor(private readonly maximumConcurrent: number) {
    if (!Number.isInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error('Filesystem host background concurrency must be positive')
    }
  }

  run<T>(task: () => Promise<T>, key: string | null = null): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Filesystem host background queue is disposed'))
    }
    return new Promise<T>((resolve, reject) => {
      this.pending.push({ key, run: task, resolve, reject } as QueuedTask<unknown>)
      this.pump()
    })
  }

  cancel(key: string): boolean {
    return this.cancelMany(new Set([key])).length > 0
  }

  cancelMany(keys: ReadonlySet<string>): string[] {
    const retained: QueuedTask<unknown>[] = []
    const cancelled = new Set<string>()
    for (const task of this.pending.splice(0)) {
      if (task.key !== null && keys.has(task.key)) {
        cancelled.add(task.key)
        task.reject(new Error('Filesystem host background task was cancelled'))
      } else {
        retained.push(task)
      }
    }
    this.pending.push(...retained)
    return [...cancelled]
  }

  dispose(): void {
    this.disposed = true
    const error = new Error('Filesystem host background queue is disposed')
    for (const task of this.pending.splice(0)) {
      task.reject(error)
    }
  }

  private pump(): void {
    while (!this.disposed && this.active < this.maximumConcurrent) {
      const task = this.pending.shift()
      if (!task) {
        return
      }
      this.active++
      void task
        .run()
        .then(task.resolve, task.reject)
        .finally(() => {
          this.active--
          this.pump()
        })
    }
  }
}
