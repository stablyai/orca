import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { selectIsSleepingWorktree } from '@/components/sidebar/workspace-actions/sleep/use-worktree-sleep-state'
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
    let sleepingWorktreeIds = new Set<string>()
    const update = (): void => {
      const state = useAppStore.getState()
      sleepingWorktreeIds = new Set(
        (state.visibleReviewWorktreeIds ?? []).filter((id) => selectIsSleepingWorktree(state, id))
      )
      const selectedOnly = isWebClientLocation()
      scheduler.update([
        ...getVisibleHostedReviewRefreshTargets(state, useAppStore.getState, { selectedOnly }),
        ...getWorkspaceReferenceRefreshTargets(state, { selectedOnly })
      ])
    }
    const visibilityChanged = (): void => {
      scheduler.setVisible(false)
      update()
      scheduler.setVisible(isWindowVisible())
    }
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      const activityChanged =
        state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
        state.agentStatusEpoch !== previous.agentStatusEpoch ||
        state.structuredChatSleptAtByPaneKey !== previous.structuredChatSleptAtByPaneKey
      if (
        visibleHostedReviewRefreshInputsChanged(state, previous) ||
        (activityChanged &&
          (state.visibleReviewWorktreeIds ?? []).some(
            (id) => sleepingWorktreeIds.has(id) !== selectIsSleepingWorktree(state, id)
          ))
      ) {
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
