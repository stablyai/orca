import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { hasHoldQuitActiveWork } from '../../../shared/hold-quit-activity'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { isWebClientLocation } from '@/lib/web-client-location'

export function useHoldQuitActivity(): void {
  useEffect(() => {
    if (
      getRendererAppPlatform() !== 'darwin' ||
      isWebClientLocation() ||
      !window.api.ui.setHoldQuitActivity
    ) {
      return
    }
    const publish = (): void => {
      const state = useAppStore.getState()
      window.api.ui.setHoldQuitActivity?.(
        state.settings?.holdQuitWhileAgentsWork === true &&
          hasHoldQuitActiveWork(state.agentStatusByPaneKey)
      )
    }
    publish()
    return useAppStore.subscribe((state, previous) => {
      if (
        state.agentStatusByPaneKey !== previous.agentStatusByPaneKey ||
        state.agentStatusEpoch !== previous.agentStatusEpoch ||
        state.settings?.holdQuitWhileAgentsWork !== previous.settings?.holdQuitWhileAgentsWork
      ) {
        publish()
      }
    })
  }, [])
}
