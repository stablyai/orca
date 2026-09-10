import { useCallback, useSyncExternalStore } from 'react'
import type { RpcClient } from './rpc-client'
import type { ConnectionState } from './types'
import type { CompatVerdict } from './protocol-compat'
import {
  UNVERIFIED_HOST_PROTOCOL,
  type HostProtocolVerification,
  type HostProtocolVerificationSource
} from './host-protocol-verifier'

export type HostStatusGates = {
  hostCapabilities: string[]
  floatingWorkspaceEnabled: boolean
  desktopAppVersion: string | null
  compatVerdict: CompatVerdict
  statusPending: boolean
  retryStatus: () => void
}

type VerifyingClient = RpcClient & Partial<HostProtocolVerificationSource>

// Reads the verdict its client already owns; probing here would tie admission — which gates
// every screen — to whichever route happens to mount this hook.
export function useHostStatusGates(args: {
  client: RpcClient | null
  connState: ConnectionState
}): HostStatusGates {
  const { client, connState } = args
  const source = client as VerifyingClient | null
  const subscribe = useCallback(
    (listener: () => void) => source?.subscribeVerification?.(listener) ?? (() => {}),
    [source]
  )
  const read = useCallback(
    (): HostProtocolVerification => source?.getVerification?.() ?? UNVERIFIED_HOST_PROTOCOL,
    [source]
  )
  const verification = useSyncExternalStore(subscribe, read, read)
  const retryStatus = useCallback(() => source?.retryVerification?.(), [source])

  return {
    hostCapabilities: verification.hostCapabilities,
    floatingWorkspaceEnabled: verification.floatingWorkspaceEnabled,
    desktopAppVersion: verification.desktopAppVersion,
    compatVerdict: verification.verdict,
    // Proven capabilities and navigation survive a transient same-generation reconnect;
    // the connection state only decides whether an outstanding probe is visible as waiting.
    statusPending: connState === 'connected' && client !== null && verification.pending,
    retryStatus
  }
}
