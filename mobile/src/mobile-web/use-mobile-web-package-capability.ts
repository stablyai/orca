import { useEffect, useMemo, useState } from 'react'
import {
  MOBILE_WEB_PACKAGE_GZIP_RUNTIME_CAPABILITY,
  MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY,
  MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import type { RpcClient } from '../transport/rpc-client'
import { startRuntimeCapabilityProbe } from '../transport/runtime-capability-probe'
import type { ConnectionState } from '../transport/types'

export type MobileWebPackageCapabilityStatus =
  | 'offline'
  | 'pending'
  | 'supported'
  | 'update-required'

export type MobileWebPackageCapability = {
  status: MobileWebPackageCapabilityStatus
  gzip: boolean
  range: boolean
}

type ResolvedPackageCapability = {
  client: RpcClient
  hostId: string
  connectionId: number | null
  supported: boolean
  gzip: boolean
  range: boolean
}

function currentConnectionId(client: RpcClient | null): number | null {
  return client && typeof client.getLastConnectedAt === 'function'
    ? client.getLastConnectedAt()
    : null
}

export function useMobileWebPackageCapability(args: {
  client: RpcClient | null
  hostId: string | undefined
  state: ConnectionState
}): MobileWebPackageCapability {
  const { client, hostId, state } = args
  const [resolved, setResolved] = useState<ResolvedPackageCapability | null>(null)
  const connectionId = currentConnectionId(client)

  useEffect(() => {
    if (state !== 'connected' || !client || !hostId) {
      return
    }
    const requestClient = client
    const requestHostId = hostId
    const requestConnectionId = connectionId
    return startRuntimeCapabilityProbe(requestClient, (capabilities) => {
      setResolved({
        client: requestClient,
        hostId: requestHostId,
        connectionId: requestConnectionId,
        supported: capabilities.includes(MOBILE_WEB_PACKAGE_RUNTIME_CAPABILITY),
        gzip: capabilities.includes(MOBILE_WEB_PACKAGE_GZIP_RUNTIME_CAPABILITY),
        range: capabilities.includes(MOBILE_WEB_PACKAGE_RANGE_RUNTIME_CAPABILITY)
      })
    })
  }, [client, connectionId, hostId, state])

  const capability =
    state !== 'connected'
      ? { status: 'offline' as const, gzip: false, range: false }
      : !client ||
          !hostId ||
          resolved?.client !== client ||
          resolved.hostId !== hostId ||
          resolved.connectionId !== connectionId
        ? { status: 'pending' as const, gzip: false, range: false }
        : {
            status: resolved.supported ? ('supported' as const) : ('update-required' as const),
            gzip: resolved.gzip,
            range: resolved.range
          }
  return useMemo(() => capability, [capability.gzip, capability.range, capability.status])
}
