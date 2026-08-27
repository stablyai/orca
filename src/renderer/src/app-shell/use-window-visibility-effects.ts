import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { useAppStore } from '../store'
import { isMac } from './app-window-chrome'

/** Window-visibility reactions that must run app-wide, not per-surface. */
export function useWindowVisibilityEffects(): void {
  const actions = useAppStore(
    useShallow((s) => ({
      refreshAllGitHub: s.refreshAllGitHub,
      reportVisibleGitHubPRRefreshCandidates: s.reportVisibleGitHubPRRefreshCandidates,
      bumpGitHubPRVisibleRefreshGeneration: s.bumpGitHubPRVisibleRefreshGeneration
    }))
  )

  // Refresh GitHub data (PR/issue status) when window regains focus
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

  // Why (STA-2383): macOS throttles the backgrounded window; on occlusion-uncover only `focus`
  // fires (invalidate-only), so the app-shell's dvh height stays stale and the bottom status bar
  // is clipped off-screen until a manual resize. Relay the genuine hidden→visible reveal so main
  // runs the same full repaint (size jiggle) that show/restore/resume get, recomputing the layout.
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
