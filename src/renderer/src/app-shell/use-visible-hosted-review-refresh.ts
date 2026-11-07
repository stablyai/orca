import { useEffect } from 'react'
import { getWorktreeCardStyle } from '../../../shared/worktree/card-style'
import { useAppStore } from '@/store'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { isWebClientLocation } from '@/lib/web-client-location'
import { createVisibleHostedReviewRefreshScheduler } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { getWorkspaceReferenceRefreshTargets } from '@/components/sidebar/workspace-card/review/workspace-reference-refresh-targets'
import {
  getVisibleHostedReviewRefreshTargets,
  visibleHostedReviewRefreshInputsChanged
} from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-targets'

export function useVisibleHostedReviewRefresh({ enabled }: { enabled: boolean }): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const scheduler = createVisibleHostedReviewRefreshScheduler()
    const update = (): void => {
      const state = useAppStore.getState()
      const selectedOnly = isWebClientLocation()
      scheduler.update([
        // Collapsed review rollups also need background reads on paired clients; this shared queue bounds them.
        ...getVisibleHostedReviewRefreshTargets(state, useAppStore.getState, {
          selectedOnly: selectedOnly && getWorktreeCardStyle(state.settings) !== 'experimental-2'
        }),
        ...getWorkspaceReferenceRefreshTargets(state, { selectedOnly })
      ])
    }
    const visibilityChanged = (): void => {
      scheduler.setVisible(false)
      update()
      scheduler.setVisible(isWindowVisible())
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (visibleHostedReviewRefreshInputsChanged(state, previous)) {
        update()
      }
    })
    update()
    visibilityChanged()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', visibilityChanged)
      scheduler.dispose()
    }
  }, [enabled])
}
