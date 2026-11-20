import type { GitRuntimeOptions } from './git-runtime-options'

/** Keep operation ownership independent of a cancelled caller. */
export function trackGitOperationWriters(options: GitRuntimeOptions): {
  options: GitRuntimeOptions
  waitForWriters?: () => Promise<void> | null
} {
  if (process.platform !== 'win32') {
    return { options }
  }
  const pending = new Set<Promise<void>>()
  return {
    options: {
      ...options,
      observeChildTermination: (terminated, writes) => {
        options.observeChildTermination?.(terminated, writes)
        if (writes) {
          pending.add(terminated)
          void terminated.then(() => pending.delete(terminated))
        }
      }
    },
    waitForWriters: () => (pending.size > 0 ? Promise.all(pending).then(() => {}) : null)
  }
}
