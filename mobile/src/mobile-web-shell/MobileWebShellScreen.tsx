import { useState } from 'react'
import { useHostClient } from '../transport/connection/host-client-hooks'
import { deriveHostCacheKey } from './generations/host-cache-key'
import {
  MobileWebShellAuthorityScreen,
  type MobileWebShellScreenProps
} from './MobileWebShellAuthorityScreen'

export type { MobileWebShellScreenProps } from './MobileWebShellAuthorityScreen'

export function MobileWebShellScreen(props: MobileWebShellScreenProps) {
  const { hostId } = props
  const { clientId } = useHostClient(hostId)
  const [held, setHeld] = useState({ hostId, clientId })
  // A reconnect can remove the live entry before restoring the same token.
  // Keep its document key while the native store still checks the live entry at acceptance.
  const authorityClientId = clientId ?? (held.hostId === hostId ? held.clientId : null)
  if (held.hostId !== hostId || held.clientId !== authorityClientId) {
    setHeld({ hostId, clientId: authorityClientId })
  }
  const authority = deriveHostCacheKey(JSON.stringify([hostId, authorityClientId]))
  return (
    <MobileWebShellAuthorityScreen
      key={authority}
      {...props}
      authorityClientId={authorityClientId}
    />
  )
}
