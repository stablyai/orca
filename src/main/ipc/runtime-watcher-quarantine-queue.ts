import { WatcherProcessFailure } from './parcel-watcher-process-failure'

type QuarantineWaiter<T> = {
  dir: string
  grant: (value: T) => void
  fail: (error: WatcherProcessFailure) => void
}

export class RuntimeWatcherQuarantineQueue<T> {
  private readonly waiters: QuarantineWaiter<T>[] = []

  constructor(private readonly capacity: number) {}

  get length(): number {
    return this.waiters.length
  }

  wait(dir: string): Promise<T> {
    if (this.waiters.length >= this.capacity) {
      return Promise.reject(
        new WatcherProcessFailure(
          'file watcher quarantine capacity exhausted',
          'supervisor',
          'process_unavailable'
        )
      )
    }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) {
          this.waiters.splice(index, 1)
        }
        callback()
      }
      const waiter: QuarantineWaiter<T> = {
        dir,
        grant: (value) => finish(() => resolve(value)),
        fail: (error) => finish(() => reject(error))
      }
      this.waiters.push(waiter)
    })
  }

  grantNext(value: T): boolean {
    const waiter = this.waiters.shift()
    waiter?.grant(value)
    return Boolean(waiter)
  }

  failRoot(dir: string): void {
    for (let index = this.waiters.length - 1; index >= 0; index--) {
      if (this.waiters[index].dir === dir) {
        this.waiters[index].fail(createQuarantineAbortError())
      }
    }
  }

  failAll(error: WatcherProcessFailure): void {
    for (const waiter of this.waiters.splice(0)) {
      waiter.fail(error)
    }
  }
}

function createQuarantineAbortError(): WatcherProcessFailure {
  return new WatcherProcessFailure(
    'file watcher subscription aborted',
    'subscription',
    'subscribe_aborted'
  )
}
