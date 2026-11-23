import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

const POST_STARTUP_GC_DELAY_MS = 6_000

let scheduled = false

/**
 * Reclaim one-shot startup module-loading garbage in main once boot settles.
 * Without this, V8 retains ~45 MiB of expanded new_space and dead startup allocations indefinitely.
 */
export function schedulePostStartupMainGc(): void {
  if (scheduled) {
    return
  }
  scheduled = true
  const timer = setTimeout(() => {
    try {
      setFlagsFromString('--expose-gc')
      const gc: unknown = runInNewContext('gc')
      setFlagsFromString('--no-expose-gc')
      if (typeof gc === 'function') {
        gc()
        gc()
      }
    } catch {
      // Best-effort memory reclaim; never fail startup.
    }
  }, POST_STARTUP_GC_DELAY_MS)
  timer.unref?.()
}
