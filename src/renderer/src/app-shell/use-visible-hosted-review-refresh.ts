import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { isWindowVisible } from '@/lib/window-activity/window-visibility-interval'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { createVisibleHostedReviewRefreshScheduler } from '@/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'
import { followOwningHostCadence } from '@/store/slices/hosted-review/refresh/owning-host-cadence-replan'
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
    // A changed cadence (this app's or a paired host's) re-plans the targets that host runs.
    const { update, dispose: stopFollowingCadence } = followOwningHostCadence(() => {
      const state = useAppStore.getState()
      const selectedOnly = isWebClientLocation()
      const targets = [
        ...getVisibleHostedReviewRefreshTargets(state, useAppStore.getState, { selectedOnly }),
        ...getWorkspaceReferenceRefreshTargets(state, { selectedOnly })
      ]
      scheduler.update(targets)
      return targets
    })
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
      stopFollowingCadence()
      document.removeEventListener('visibilitychange', visibilityChanged)
      scheduler.dispose()
    }
  }, [enabled])
}
