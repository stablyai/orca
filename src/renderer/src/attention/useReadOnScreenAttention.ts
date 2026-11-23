import { useEffect } from 'react'
import { subscribeStructuredAttentionViews } from '@/attention/agent-subject-read-actions'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { subscribeAutoAckPresenceSignals } from './agent-auto-ack-presence'
import { createNotchViewReporter } from '@/components/notch/notch-view-report'
import { useAppStore } from '@/store/index'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { startOnScreenAttentionScan } from './on-screen-attention-scan'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-list/feed/sidebar-inputs-switch'
import {
  createClientWorkspaceViewReporter,
  subscribeViewReportPresenceSignals
} from './client-workspace-view-report'

export function useReadOnScreenAttention(): void {
  const showNotch =
    useAppStore((state) => state.settings?.showNotchAgentStatus === true) &&
    !isWebClientLocation() &&
    getRendererAppPlatform() === 'darwin'
  useEffect(() => {
    const base = ORCA_SIDEBAR_INPUTS_IS_MAIN ? createClientWorkspaceViewReporter() : undefined
    const stop = startOnScreenAttentionScan(useAppStore, {
      readDesktopAway: isWebClientLocation()
        ? null
        : async () => window.api?.notifications?.getDesktopAwayState?.(),
      subscribeStructuredViews: subscribeStructuredAttentionViews,
      subscribePresenceSignals:
        showNotch || base ? subscribeViewReportPresenceSignals : subscribeAutoAckPresenceSignals,
      viewReporter: showNotch ? createNotchViewReporter(base) : base
    })
    return () => {
      stop()
      if (showNotch) {
        window.api.notch?.setViewedPanes([])
      }
    }
  }, [showNotch])
}
