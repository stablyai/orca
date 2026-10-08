type Entry = {
  start: () => void
  cancel: () => void
  preempt?: () => void
  priority: boolean
  rawInput: boolean
  settled: boolean
}

type Lane = { active: Entry; pending: Entry[]; draining: boolean }

type QueueOptions = {
  signal?: AbortSignal
  deadlineAt?: number
  priority?: boolean
  rawInput?: boolean
  preempt?: () => void
}

export class KeyedOperationQueue {
  private readonly lanes = new Map<string, Lane>()

  get size(): number {
    return this.lanes.size
  }

  run<T>(key: string, operation: () => T | Promise<T>, options: QueueOptions = {}): T | Promise<T> {
    if (options.signal?.aborted) {
      throw new Error('request_aborted')
    }
    if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
      throw new Error('request_timeout')
    }
    const lane = this.lanes.get(key)
    if (lane) {
      if (options.priority) {
        lane.active.preempt?.()
      }
      return this.enqueue(key, lane, operation, options)
    }
    const entry: Entry = {
      start: () => {},
      cancel: () => {},
      preempt: options.preempt,
      priority: options.priority === true,
      rawInput: options.rawInput === true,
      settled: false
    }
    const created: Lane = { active: entry, pending: [], draining: false }
    this.lanes.set(key, created)
    return this.invoke(key, created, entry, operation)
  }

  private invoke<T>(
    key: string,
    lane: Lane,
    entry: Entry,
    operation: () => T | Promise<T>
  ): T | Promise<T> {
    try {
      const result = operation()
      if (result instanceof Promise) {
        return result.finally(() => this.release(key, lane, entry))
      }
      this.release(key, lane, entry)
      return result
    } catch (error) {
      this.release(key, lane, entry)
      throw error
    }
  }

  private enqueue<T>(
    key: string,
    lane: Lane,
    operation: () => T | Promise<T>,
    options: QueueOptions
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = options.signal
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined
      const cleanup = (): void => {
        signal?.removeEventListener('abort', entry.cancel)
        clearTimeout(deadlineTimer)
      }
      const cancel = (reason: string): void => {
        const index = lane.pending.indexOf(entry)
        if (index === -1) {
          return
        }
        lane.pending.splice(index, 1)
        cleanup()
        reject(new Error(reason))
      }
      const entry: Entry = {
        priority: options.priority === true,
        rawInput: options.rawInput === true,
        settled: false,
        preempt: options.preempt,
        start: () => {
          cleanup()
          if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
            this.release(key, lane, entry)
            reject(new Error('request_timeout'))
            return
          }
          try {
            resolve(this.invoke(key, lane, entry, operation))
          } catch (error) {
            reject(error)
          }
        },
        cancel: () => cancel('request_aborted')
      }
      const lastRawInput = lane.pending.findLastIndex((pending) => pending.rawInput)
      const index = options.priority
        ? lane.pending.findIndex(
            (pending, position) => position > lastRawInput && !pending.priority
          )
        : -1
      if (index === -1) {
        lane.pending.push(entry)
      } else {
        lane.pending.splice(index, 0, entry)
      }
      signal?.addEventListener('abort', entry.cancel, { once: true })
      if (options.deadlineAt !== undefined) {
        deadlineTimer = setTimeout(
          () => cancel('request_timeout'),
          Math.max(0, options.deadlineAt - Date.now())
        )
      }
      if (signal?.aborted) {
        entry.cancel()
      }
    })
  }

  private release(key: string, lane: Lane, entry: Entry): void {
    if (this.lanes.get(key) !== lane || lane.active !== entry) {
      return
    }
    entry.settled = true
    if (lane.draining) {
      return
    }
    lane.draining = true
    try {
      // Drain synchronous queued writes without growing the call stack.
      while (lane.active.settled) {
        const next = lane.pending.shift()
        if (!next) {
          this.lanes.delete(key)
          return
        }
        lane.active = next
        next.start()
      }
    } finally {
      lane.draining = false
    }
  }
}
