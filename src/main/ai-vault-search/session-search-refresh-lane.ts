import { waitForPromiseWithSignal, throwIfSignalAborted } from '../../shared/abort-signal-reason'
import type { SessionSearchScanRoots } from './session-search-service'

type Refresh = { controller: AbortController; promise: Promise<void>; users: number }

/** Share concurrent query refreshes, never completed filesystem snapshots. */
export class SessionSearchRefreshLane {
  private readonly runs = new Map<string, Refresh>()

  async run(
    roots: SessionSearchScanRoots,
    refresh: (signal: AbortSignal) => Promise<void>,
    signal?: AbortSignal
  ): Promise<void> {
    throwIfSignalAborted(signal)
    const key = JSON.stringify(Object.entries(roots).sort(([a], [b]) => a.localeCompare(b)))
    let run = this.runs.get(key)
    if (!run) {
      const controller = new AbortController()
      run = { controller, users: 0, promise: Promise.resolve() }
      const current = run
      run.promise = Promise.resolve()
        .then(() => {
          throwIfSignalAborted(controller.signal)
          return refresh(controller.signal)
        })
        .finally(() => {
          if (this.runs.get(key) === current) {
            this.runs.delete(key)
          }
        })
      this.runs.set(key, run)
    }
    run.users++
    try {
      await waitForPromiseWithSignal(run.promise, signal)
    } finally {
      run.users--
      if (run.users === 0) {
        run.controller.abort()
        if (this.runs.get(key) === run) {
          this.runs.delete(key)
        }
      }
    }
  }

  cancel(): void {
    for (const run of this.runs.values()) {
      run.controller.abort()
    }
    this.runs.clear()
  }
}
