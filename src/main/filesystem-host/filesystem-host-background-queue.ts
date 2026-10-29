import { remainingFilesystemHostBudget } from './filesystem-host-deadline'
import { FilesystemHostSupervisorError } from './filesystem-host-supervisor-error'

type QueuedTask = {
  key: string | null
  domain: string
  run: () => Promise<void>
  timer?: ReturnType<typeof setTimeout>
  reject: (error: unknown) => void
}

export type FilesystemHostBackgroundAdmission = Pick<FilesystemHostBackgroundQueue, 'run'>

export class FilesystemHostBackgroundQueue {
  private readonly active = new Map<string, number>()
  private disposed = false
  private readonly pending: QueuedTask[] = []

  constructor(private readonly maximumConcurrent: number) {
    if (!Number.isInteger(maximumConcurrent) || maximumConcurrent < 1) {
      throw new Error('Filesystem host background concurrency must be positive')
    }
  }

  run<T>(
    task: (remainingMs: number) => Promise<T>,
    key: string | null = null,
    expiresAt = Infinity,
    domain = ''
  ): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Filesystem host background queue is disposed'))
    }
    const active = [...this.active.values()].reduce((total, count) => total + count, 0)
    if (
      this.pending.length >= 128 ||
      active + this.pending.length >= 128 + this.maximumConcurrent
    ) {
      return Promise.reject(
        new FilesystemHostSupervisorError('capacity', 'Filesystem host background queue is full')
      )
    }
    return new Promise<T>((resolve, reject) => {
      const queued: QueuedTask = {
        key,
        domain,
        run: async () => {
          try {
            resolve(await task(remainingFilesystemHostBudget(expiresAt)))
          } catch (error) {
            reject(error)
          }
        },
        reject
      }
      if (Number.isFinite(expiresAt)) {
        queued.timer = setTimeout(
          () => {
            const index = this.pending.indexOf(queued)
            if (index !== -1) {
              this.pending.splice(index, 1)
              reject(
                new FilesystemHostSupervisorError('deadline', 'Filesystem host admission expired')
              )
            }
          },
          Math.max(0, expiresAt - Date.now())
        )
      }
      this.pending.push(queued)
      this.pump()
    })
  }

  cancel(key: string): boolean {
    return this.cancelMany(new Set([key])).length > 0
  }

  cancelMany(keys: ReadonlySet<string>): string[] {
    const retained: QueuedTask[] = []
    const cancelled = new Set<string>()
    for (const task of this.pending.splice(0)) {
      if (task.key !== null && keys.has(task.key)) {
        cancelled.add(task.key)
        clearTimeout(task.timer)
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
      clearTimeout(task.timer)
      task.reject(error)
    }
  }

  private pump(): void {
    while (!this.disposed) {
      const index = this.pending.findIndex(
        (task) => (this.active.get(task.domain) ?? 0) < this.maximumConcurrent
      )
      if (index === -1) {
        return
      }
      const [task] = this.pending.splice(index, 1)
      clearTimeout(task.timer)
      this.active.set(task.domain, (this.active.get(task.domain) ?? 0) + 1)
      void task.run().finally(() => {
        const active = (this.active.get(task.domain) ?? 1) - 1
        if (active === 0) {
          this.active.delete(task.domain)
        } else {
          this.active.set(task.domain, active)
        }
        this.pump()
      })
    }
  }
}
