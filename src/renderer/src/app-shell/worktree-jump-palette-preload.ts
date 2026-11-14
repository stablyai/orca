import { useEffect } from 'react'
import { scheduleAfterInputQuiet } from '@/lib/window-activity/input-quiet-scheduler'
import { lazyWithPreload } from '@/app-shell/startup/lazy-with-retry'

export const WorktreeJumpPalette = lazyWithPreload(
  () => import('../components/worktree-jump/WorktreeJumpPalette')
)

/** Loads the Cmd+J palette after startup settles so its first open renders without suspending. */
export function usePreloadWorktreeJumpPalette(): void {
  useEffect(
    () =>
      scheduleAfterInputQuiet(WorktreeJumpPalette.preload, {
        delayMs: 500,
        quietMs: 300,
        idleTimeoutMs: 1_000,
        maxWaitMs: 2_000
      }),
    []
  )
}
