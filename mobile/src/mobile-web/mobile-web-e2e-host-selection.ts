import { useEffect } from 'react'
import type { HostProfile } from '../transport/types'

type HostIdentity = Pick<HostProfile, 'id' | 'publicKeyB64'>

export function mobileWebE2eHostId(
  hosts: readonly HostIdentity[],
  publicKey: string | undefined
): string | undefined {
  return publicKey ? hosts.find((host) => host.publicKeyB64 === publicKey)?.id : undefined
}

export function useMobileWebE2eHostSelection(
  hosts: readonly HostIdentity[],
  selectedHostId: string | undefined,
  selectHost: (hostId: string | undefined) => void
): string | undefined {
  const e2eHostId = mobileWebE2eHostId(
    hosts,
    process.env.EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_HOST_PUBLIC_KEY
  )
  useEffect(() => {
    if (e2eHostId && e2eHostId !== selectedHostId) {
      selectHost(e2eHostId)
    }
  }, [e2eHostId, selectHost, selectedHostId])
  return e2eHostId
}
