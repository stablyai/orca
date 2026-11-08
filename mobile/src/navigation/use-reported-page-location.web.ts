import { useEffect } from 'react'
import { useGlobalSearchParams, useSegments } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import { firstParam } from './route-param-reader'
import { workspaceRouteHref } from './workspace-execution-host'

// Tell the shell which session this document shows, so it can treat a notification for it as already seen.
export function useReportedPageLocation(): void {
  const client = usePageBridgeClient()
  const segments = useSegments()
  const params = useGlobalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    executionHost?: string | string[]
  }>()
  const host = `/h/${encodeURIComponent(firstParam(params.hostId))}`
  const worktreeId = firstParam(params.worktreeId)
  const href =
    segments.at(-2) === 'session' && worktreeId !== ''
      ? workspaceRouteHref(
          `${host}/session/${encodeURIComponent(worktreeId)}`,
          normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
        )
      : host
  useEffect(() => {
    client.notifyPageLocation(href)
  }, [client, href])
}
