import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react'
import type { MobilePrSidebarController } from '../session/use-mobile-pr-sidebar-controller'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileSourceControlLoaders } from './use-mobile-source-control-loaders'

type Params = {
  client: RpcClient | null
  worktreeId: string
  loadStatus: MobileSourceControlLoaders['loadStatus']
  prController: MobilePrSidebarController
  includeDetails: boolean
}

export function useMobileSourceControlRefresh({
  client,
  worktreeId,
  loadStatus,
  prController,
  includeDetails
}: Params) {
  const [request, setRequest] = useState<{ client: typeof client; worktreeId: string } | null>(null)
  const consumedRequest = useRef(request)
  const refreshCommittedPr = useEffectEvent(() => {
    void prController.refetchPRSidebar({ includeDetails })
  })
  useEffect(() => {
    if (request !== null && request !== consumedRequest.current) {
      consumedRequest.current = request
      if (request.client === client && request.worktreeId === worktreeId) {
        refreshCommittedPr()
      }
    }
  }, [request, client, worktreeId])
  const refreshRepoProbe = prController.refreshPRSidebarRepoProbe
  return useCallback(() => {
    void Promise.all([
      loadStatus({ force: true, preserveReadyOnFailure: true, rereadSettings: true }),
      refreshRepoProbe()
    ]).then(([statusLoaded, hosted]) => {
      if (statusLoaded && hosted) {
        // Read the PR after React commits the refreshed branch and HEAD.
        setRequest({ client, worktreeId })
      }
    })
  }, [client, worktreeId, loadStatus, refreshRepoProbe])
}
