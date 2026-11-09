import { useEffect } from 'react'
import { getWorktreeCardStyle } from '../../../shared/worktree/card-style'
import { useAppStore } from '@/store/index'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { createVisibleHostedReviewRefreshScheduler } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { createWorkspaceReferenceRefreshTargetsSelector } from '@/components/sidebar/workspace-card/review/workspace-reference-refresh-targets'
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
    const selectedOnly = isWebClientLocation()
    const selectReferences = createWorkspaceReferenceRefreshTargetsSelector({ selectedOnly })
    let hostedTargets: ReturnType<typeof getVisibleHostedReviewRefreshTargets> = []
    let referenceTargets: ReturnType<typeof selectReferences> = []
    const update = (reviewInputsChanged: boolean): void => {
      const state = useAppStore.getState()
      const references = selectReferences(state, reviewInputsChanged)
      if (!reviewInputsChanged && references === referenceTargets) {
        return
      }
      referenceTargets = references
      if (reviewInputsChanged) {
        hostedTargets = getVisibleHostedReviewRefreshTargets(state, useAppStore.getState, {
          selectedOnly: selectedOnly && getWorktreeCardStyle(state.settings) !== 'experimental-2'
        })
      }
      scheduler.update([
        // Collapsed review rollups also need background reads on paired clients; this shared queue bounds them.
        ...hostedTargets,
        ...referenceTargets
      ])
    }
    const visibilityChanged = (): void => {
      scheduler.setVisible(false)
      update(true)
      scheduler.setVisible(isWindowVisible())
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      update(visibleHostedReviewRefreshInputsChanged(state, previous))
    })
    visibilityChanged()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', visibilityChanged)
      scheduler.dispose()
    }
  }, [enabled])
}
