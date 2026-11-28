import type { StartedPluginWorker } from './plugin-worker-startup'

export function createWorkerPressureCheck(options: {
  waiting(): boolean
  workers: ReadonlyMap<string, StartedPluginWorker>
  stop(worker: StartedPluginWorker): void
}): () => void {
  let scheduled = false
  return () => {
    if (scheduled || !options.waiting()) {
      return
    }
    scheduled = true
    // Let resolved activations dispatch their command before checking the current queue and handles.
    setImmediate(() => {
      scheduled = false
      if (!options.waiting()) {
        return
      }
      let oldest: StartedPluginWorker | undefined
      for (const worker of options.workers.values()) {
        if (
          !worker.spec.keepWarm &&
          worker.handle.canSleepUnderPressure?.() &&
          (!oldest || worker.handle.lastActivityAt() < oldest.handle.lastActivityAt())
        ) {
          oldest = worker
        }
      }
      if (oldest) {
        options.stop(oldest)
      }
    })
  }
}
