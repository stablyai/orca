import { useEffect } from 'react'
import { useGlobalSearchParams, useSegments } from 'expo-router'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import { firstParam } from './route-param-reader'
import { workspaceRouteHref } from './workspace-execution-host'
import { STANDALONE_SESSION_PARAM } from './host-stack-navigation'

// Tell the shell which session this document shows, so it can treat a notification for it as already seen.
export function useReportedPageLocation(): void {
  const client = usePageBridgeClient()
  const segments = useSegments()
  const params = useGlobalSearchParams<{
    hostId?: string | string[]
    worktreeId?: string | string[]
    executionHost?: string | string[]
    standalone?: string | string[]
  }>()
  const host = `/h/${encodeURIComponent(firstParam(params.hostId))}`
  const worktreeId = firstParam(params.worktreeId)
  // Keep standalone so a restored document again opens without the list beneath.
  const standalone = firstParam(params[STANDALONE_SESSION_PARAM]) === '1'
  const href =
    segments.at(-2) === 'session' && worktreeId !== ''
      ? workspaceRouteHref(
          `${host}/session/${encodeURIComponent(worktreeId)}${standalone ? `?${STANDALONE_SESSION_PARAM}=1` : ''}`,
          normalizeExecutionHostId(firstParam(params.executionHost)) ?? undefined
        )
      : host
  useEffect(() => {
    client.notifyPageLocation(href)
  }, [client, href])
}
