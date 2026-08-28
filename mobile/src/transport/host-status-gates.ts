import { useEffect, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, RpcSuccess } from './types'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'
import { normalizeHostAppVersion, recordHostAppVersion } from './host-app-version-store'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  statusPending: boolean
}

// statusPending is not stored: pending-ness belongs to the live connection, not to the answer.
type LoadedHostStatusGates = Omit<HostStatusGates, 'statusPending'> & {
  hostId: string | undefined
  client: RpcClient
}

const EMPTY_HOST_CAPABILITIES: string[] = []

// Reads status.get on connect for capabilities, protocol-compat verdict, and the
// floating-workspace flag. Compat constants are wide-open today so this never blocks yet.
export function useHostStatusGates(args: {
  hostId: string | undefined
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { hostId, client, connState } = args
  const [loaded, setLoaded] = useState<LoadedHostStatusGates | null>(null)
  // Why (F10): a drop must not erase proven capabilities, but it does invalidate them — this keeps
  // statusPending true across the reconnect refetch, so gates stay "unknown" while the data survives.
  const [unverified, setUnverified] = useState(false)

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      setUnverified(true)
      return
    }
    let cancelled = false
    const requestClient = client
    const settle = (gates: Omit<HostStatusGates, 'statusPending'>) => {
      setLoaded({ hostId, client: requestClient, ...gates })
      setUnverified(false)
    }
    void (async () => {
      try {
        const response = await requestClient.sendRequest('status.get')
        if (cancelled) {
          return
        }
        if (!response.ok) {
          settle({
            hostCapabilities: [],
            floatingWorkspaceEnabled: false,
            desktopAppVersion: null,
            compatVerdict: { kind: 'ok' }
          })
          return
        }
        const status = (response as RpcSuccess).result as DesktopStatus & {
          capabilities?: string[]
        }
        const verdict = evaluateCompat({
          desktopProtocolVersion: status.protocolVersion,
          desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
        })
        const desktopAppVersion = normalizeHostAppVersion(status.appVersion)
        if (hostId && desktopAppVersion) {
          void recordHostAppVersion(hostId, desktopAppVersion)
        }
        settle({
          hostCapabilities: status.capabilities ?? [],
          floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
          desktopAppVersion,
          compatVerdict: verdict
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
      } catch {
        // Why: a transient status failure must not trap navigation; conservative feature gates remain disabled.
        if (!cancelled) {
          settle({
            hostCapabilities: [],
            floatingWorkspaceEnabled: false,
            desktopAppVersion: null,
            compatVerdict: { kind: 'ok' }
          })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client, connState, hostId])

  // Why: effects run after render, so key loaded gates by host and client to fail closed during route reuse.
  const proven = loaded && loaded.hostId === hostId && loaded.client === client ? loaded : null
  if (!proven) {
    return {
      hostCapabilities: EMPTY_HOST_CAPABILITIES,
      floatingWorkspaceEnabled: false,
      desktopAppVersion: null,
      compatVerdict: { kind: 'ok' },
      statusPending: connState === 'connected' && client !== null
    }
  }
  return {
    hostCapabilities: proven.hostCapabilities,
    floatingWorkspaceEnabled: proven.floatingWorkspaceEnabled,
    desktopAppVersion: proven.desktopAppVersion,
    compatVerdict: proven.compatVerdict,
    // Why (F10): unchanged pending timing — the reconnect refetch is still "unknown", it just no
    // longer blanks the capabilities this same host already proved.
    statusPending: connState === 'connected' && unverified
  }
}
