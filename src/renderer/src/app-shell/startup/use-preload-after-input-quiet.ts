import { useEffect } from 'react'
import { scheduleAfterInputQuiet } from '@/lib/window-activity/input-quiet-scheduler'

/** Runs a lazy chunk's preload once input settles so its first open renders without suspending. */
export function usePreloadAfterInputQuiet(preload: () => void, enabled = true): void {
  useEffect(
    () =>
      enabled
        ? scheduleAfterInputQuiet(preload, {
            delayMs: 500,
            quietMs: 300,
            idleTimeoutMs: 1_000,
            maxWaitMs: 2_000
          })
        : undefined,
    [preload, enabled]
  )
}
