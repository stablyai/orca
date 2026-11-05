type SharedTask = { controller: AbortController; callers: number; done: Promise<void> }

export class CallerJoinedSharedTasks<K> {
  private readonly tasks = new Map<K, SharedTask>()

  has(key: K): boolean {
    return this.tasks.has(key)
  }

  /** Settles when the task finishes or this caller aborts; task failures never reject callers. */
  join(key: K, signal: AbortSignal, start: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (signal.aborted) {
      return Promise.resolve()
    }
    const task = this.tasks.get(key) ?? this.start(key, start)
    task.callers += 1
    return new Promise((resolve) => {
      let joined = true
      const leave = (): boolean => {
        if (!joined) {
          return false
        }
        joined = false
        signal.removeEventListener('abort', onAbort)
        resolve()
        return true
      }
      const onAbort = (): void => {
        if (!leave()) {
          return
        }
        task.callers -= 1
        if (task.callers === 0) {
          if (this.tasks.get(key) === task) {
            this.tasks.delete(key)
          }
          task.controller.abort(signal.reason)
        }
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void task.done.then(leave)
    })
  }

  private start(key: K, start: (signal: AbortSignal) => Promise<void>): SharedTask {
    const controller = new AbortController()
    const task: SharedTask = {
      controller,
      callers: 0,
      done: new Promise<void>((resolve) => resolve(start(controller.signal)))
        .catch(() => {})
        .finally(() => {
          if (this.tasks.get(key) === task) {
            this.tasks.delete(key)
          }
        })
    }
    this.tasks.set(key, task)
    return task
  }
}
