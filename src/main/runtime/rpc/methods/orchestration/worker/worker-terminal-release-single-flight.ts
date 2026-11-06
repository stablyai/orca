import type { WorkerTerminalReleaseRuntime } from '../../../../orchestration/worker-terminal-release-runtime'

type ActiveRelease<T> = { promise: Promise<T>; recoveryRequested: boolean }

/** One release per resource per runtime: a timer, recovery and an explicit release all join it. */
export class WorkerTerminalReleaseSingleFlight<T> {
  private readonly activeByRuntime = new WeakMap<
    WorkerTerminalReleaseRuntime,
    Map<string, ActiveRelease<T>>
  >()

  run(
    runtime: WorkerTerminalReleaseRuntime,
    key: string,
    mode: 'interactive' | 'recovery' | undefined,
    start: (active: { readonly recoveryRequested: boolean }) => Promise<T>
  ): Promise<T> {
    let activeByKey = this.activeByRuntime.get(runtime)
    if (!activeByKey) {
      activeByKey = new Map()
      this.activeByRuntime.set(runtime, activeByKey)
    }
    const active = activeByKey.get(key)
    if (active) {
      active.recoveryRequested ||= mode === 'recovery'
      return active.promise
    }
    const record: { recoveryRequested: boolean; promise?: Promise<T> } = {
      recoveryRequested: mode === 'recovery'
    }
    const promise = start(record).finally(() => {
      if (activeByKey.get(key) === entry) {
        activeByKey.delete(key)
      }
    })
    const entry: ActiveRelease<T> = Object.assign(record, { promise })
    activeByKey.set(key, entry)
    return promise
  }
}
