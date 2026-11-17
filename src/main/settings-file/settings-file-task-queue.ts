import type { SettingsFileSyncDeps } from './settings-file-sync-types'

/** Runs tasks one at a time; a failed task is logged and does not stop later ones. */
export function createSettingsFileTaskQueue(
  log: SettingsFileSyncDeps['log']
): (task: () => Promise<void>) => Promise<void> {
  let queue: Promise<void> = Promise.resolve()
  return (task) => {
    const run = queue.then(task).catch((error) => {
      log.warn(
        `settings file task failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    queue = run
    return run
  }
}
