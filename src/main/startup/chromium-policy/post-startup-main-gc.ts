import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'

const POST_STARTUP_GC_DELAYS_MS = [6_000, 36_000] as const

let scheduled = false

function runMainGc(): void {
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
}

/**
 * Reclaim one-shot startup and deferred-startup garbage in main once boot and idle workers settle.
 * Without this, V8 retains ~45+ MiB of expanded new_space and dead startup allocations indefinitely.
 */
export function schedulePostStartupMainGc(): void {
  if (scheduled) {
    return
  }
  scheduled = true
  try {
    setFlagsFromString('--optimize-for-size')
  } catch {
    // Best-effort V8 compaction hint.
  }
  for (const delayMs of POST_STARTUP_GC_DELAYS_MS) {
    const timer = setTimeout(runMainGc, delayMs)
    timer.unref?.()
  }
}
