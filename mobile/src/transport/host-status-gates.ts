import { useEffect, useState } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState, RpcSuccess } from './types'
import { evaluateCompat, type CompatVerdict } from './protocol-compat'
import type { DesktopStatus } from '../worktree/host-worktree-rpc-types'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  compatVerdict: CompatVerdict
}

type LoadedHostStatusGates = HostStatusGates & {
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

  useEffect(() => {
    if (connState !== 'connected' || !client) {
      // Why: reconnecting the same host/client must revalidate gates instead of reviving its prior status response.
      setLoaded(null)
      return
    }
    let cancelled = false
    const requestClient = client
    void (async () => {
      try {
        const response = await requestClient.sendRequest('status.get')
        if (cancelled) {
          return
        }
        if (!response.ok) {
          return
        }
        const status = (response as RpcSuccess).result as DesktopStatus & {
          capabilities?: string[]
        }
        const verdict = evaluateCompat({
          desktopProtocolVersion: status.protocolVersion,
          desktopMinCompatibleMobileVersion: status.minCompatibleMobileVersion
        })
        setLoaded({
          hostId,
          client: requestClient,
          hostCapabilities: status.capabilities ?? [],
          floatingWorkspaceEnabled: status.floatingWorkspaceEnabled === true,
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
        // Why: sendRequest can throw on transport tear-down; the fail-closed return below keeps gated actions hidden.
      }
    })()
    return () => {
      cancelled = true
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
      compatVerdict: { kind: 'ok' }
    }
  }
  return {
    hostCapabilities: loaded.hostCapabilities,
    floatingWorkspaceEnabled: loaded.floatingWorkspaceEnabled,
    compatVerdict: loaded.compatVerdict
  }
}
