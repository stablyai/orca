import { useEffect, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, RpcSuccess } from './types'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  compatVerdict: CompatVerdict
  statusPending: boolean
  // Why: null when the host predates the field — callers show no update nudge.
  recommendedMobileAppVersions: DesktopStatus['recommendedMobileAppVersions'] | null
}

type LoadedHostStatusGates = HostStatusGates & {
  hostId: string | undefined
  client: RpcClient
}

const EMPTY_HOST_CAPABILITIES: string[] = []
const RECOMMENDATION_REFRESH_DELAY_MS = 6_000

// Reads status.get on connect for capabilities, protocol-compat verdict, and the
// floating-workspace flag. Compat constants are wide-open today so this never blocks yet.
export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      // Why: reconnecting the same host/client must revalidate gates instead of reviving its prior status response.
      setLoaded(null)
      return
    }
    let cancelled = false
    let recommendationRefreshTimer: ReturnType<typeof setTimeout> | null = null
    const requestClient = client
    const setFallbackGates = () => {
      setLoaded({
        hostId,
        client: requestClient,
        hostCapabilities: [],
        floatingWorkspaceEnabled: false,
        compatVerdict: { kind: 'ok' },
        statusPending: false,
        recommendedMobileAppVersions: null
      })
    }
    const loadStatus = async (recommendationRefresh: boolean): Promise<void> => {
      try {
        const response = await requestClient.sendRequest('status.get')
        if (cancelled) {
          return
        }
        if (!response.ok) {
          if (!recommendationRefresh) {
            setFallbackGates()
          }
          return
        }
        const status = (response as RpcSuccess).result as DesktopStatus & {
          capabilities?: string[]
        }
        const verdict = evaluateCompat({
          desktopProtocolVersion: status.protocolVersion,
          desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
        })
        const recommendedMobileAppVersions = readRecommendedMobileAppVersions(status)
        setLoaded({
          hostId,
          client: requestClient,
          hostCapabilities: status.capabilities ?? [],
          floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
          compatVerdict: verdict,
          statusPending: false,
          recommendedMobileAppVersions
        })
        if (verdict.kind === 'blocked') {
          // Why: support breadcrumb to confirm a block fired vs a render bug; no PII, just version ints.
          console.warn('[protocol-compat] blocked', {
            reason: verdict.reason,
            desktopVersion: verdict.desktopVersion,
            requiredMobileVersion: verdict.requiredMobileVersion,
            requiredDesktopVersion: verdict.requiredDesktopVersion
          })
        }
        if (
          !recommendationRefresh &&
          verdict.kind !== 'blocked' &&
          !recommendedMobileAppVersions &&
          status.recommendedMobileAppVersionsPending === true
        ) {
          // The desktop fetch has a 5s deadline; one delayed read observes its cache
          // without polling or adding work for older hosts.
          recommendationRefreshTimer = setTimeout(() => {
            recommendationRefreshTimer = null
            void loadStatus(true)
          }, RECOMMENDATION_REFRESH_DELAY_MS)
        }
      } catch {
        // Why: a transient status failure must not trap navigation; conservative feature gates remain disabled.
        if (!cancelled && !recommendationRefresh) {
          setFallbackGates()
        }
      }
    }
    void loadStatus(false)
    return () => {
      cancelled = true
      if (recommendationRefreshTimer) {
        clearTimeout(recommendationRefreshTimer)
      }
    }
  }, [client, connState, hostId])

  // Why: effects run after render, so key loaded gates by host and client to fail closed during route reuse.
  if (
    connState !== 'connected' ||
    !client ||
    !loaded ||
    loaded.hostId !== hostId ||
    loaded.client !== client
  ) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      compatVerdict: { kind: 'ok' },
      statusPending: connState === 'connected' && client !== null,
      recommendedMobileAppVersions: null
    }
  }
  return {
    hostCapabilities: loaded.hostCapabilities,
    floatingWorkspaceEnabled: loaded.floatingWorkspaceEnabled,
    compatVerdict: loaded.compatVerdict,
    statusPending: false,
    recommendedMobileAppVersions: loaded.recommendedMobileAppVersions
  }
}

function readRecommendedMobileAppVersions(
  status: DesktopStatus
): DesktopStatus['recommendedMobileAppVersions'] | null {
  const versions = status.recommendedMobileAppVersions
  if (!versions || typeof versions !== 'object') {
    return null
  }
  const ios = typeof versions.ios === 'string' ? versions.ios : undefined
  const android = typeof versions.android === 'string' ? versions.android : undefined
  return ios || android ? { ios, android } : null
}
