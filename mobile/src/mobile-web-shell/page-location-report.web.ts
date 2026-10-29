import { useEffect } from 'react'
import { useGlobalSearchParams, useSegments } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { firstParam } from '../navigation/route-param-reader'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'
import { encodedRouteHref } from './encoded-route-href'

// Report in-document hops while this page owns the host area, so a fold can reopen the same screen natively.
// Keep executionHost so the reopened workspace stays on its server; one-shot params like paneKey are not replayed.
export function useReportedPageLocation(): void {
  const client = usePageBridgeClientIfPresent()
  const ownsHostArea = client?.getShellSession()?.ownsHostArea === true
  const params = useGlobalSearchParams()
  const executionHost = normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
  const href = workspaceRouteHref(encodedRouteHref(useSegments(), params), executionHost)
  useEffect(() => {
    if (client && ownsHostArea) {
      client.notifyPageLocation(href)
    }
  }, [client, ownsHostArea, href])
}
