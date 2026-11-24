import type { SettingsFileSyncDeps } from './settings-file-sync-types'

export type SettingsFileTaskQueue = {
  /** A failed task is logged and does not stop later ones. */
  enqueue: (task: () => Promise<void>) => Promise<void>
  /** Like `enqueue`, but the caller also receives the task's failure. */
  enqueueReporting: (task: () => Promise<void>) => Promise<void>
}

/** Runs tasks one at a time. */
export function createSettingsFileTaskQueue(
  log: SettingsFileSyncDeps['log']
): SettingsFileTaskQueue {
  let queue: Promise<void> = Promise.resolve()
  const enqueueReporting = (task: () => Promise<void>): Promise<void> => {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }
  return {
    enqueueReporting,
    enqueue: (task) =>
      enqueueReporting(task).catch((error) => {
        log.warn(
          `settings file task failed: ${error instanceof Error ? error.message : String(error)}`
        )
      })
  }
}
