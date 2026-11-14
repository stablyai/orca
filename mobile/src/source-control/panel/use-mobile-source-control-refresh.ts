import { useCallback } from 'react'
import type { MobilePrSidebarController } from '../review/use-mobile-pr-sidebar-controller'
import type { MobileSourceControlLoaders } from '../changes/use-mobile-source-control-loaders'

type Params = {
  loadStatus: MobileSourceControlLoaders['loadStatus']
  prController: MobilePrSidebarController
  includeDetails: boolean
}

// Status, the GitHub probe and the PR are read together; a branch or HEAD the status read moves to reads its own PR.
export function useMobileSourceControlRefresh({
  loadStatus,
  prController,
  includeDetails
}: Params) {
  const { refreshPRSidebarRepoProbe, refetchPRSidebar } = prController
  return useCallback(() => {
    void loadStatus({ force: true, rereadSettings: true })
    void refreshPRSidebarRepoProbe()
    void refetchPRSidebar({ includeDetails, refresh: true })
  }, [includeDetails, loadStatus, refetchPRSidebar, refreshPRSidebarRepoProbe])
}
