import { useEffect } from 'react'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { useAppStore } from '../store'
import { isMac } from './app-window-chrome'
import { selectWindowVisibilityActions } from './window-visibility-actions-selector'

/** Window-visibility reactions that must run app-wide, not per-surface. */
export function useWindowVisibilityEffects(): void {
  const actions = useAppStore(selectWindowVisibilityActions)

  useEffect(() => {
    const handler = (): void => {
      if (document.visibilityState === 'visible') {
        actions.refreshAllGitHub()
        actions.bumpGitHubPRVisibleRefreshGeneration()
      } else {
        actions.reportVisibleGitHubPRRefreshCandidates([], Date.now())
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [actions])

  // macOS occlusion can leave dvh stale because focus only invalidates. Relay hidden→visible to main’s full repaint so the status bar is not clipped (STA-2383).
  useEffect(() => {
    if (!isMac || isPairedWebClientWindow()) {
      return
    }
    const handler = (): void => {
      if (document.visibilityState !== 'visible') {
        return
      }
      window.api?.ui?.notifyWindowRevealed?.()
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])
}
