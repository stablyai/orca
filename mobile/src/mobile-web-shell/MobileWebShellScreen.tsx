import { useHostClient } from '../transport/connection/host-client-hooks'
import { deriveHostCacheKey } from './generations/host-cache-key'
import {
  MobileWebShellAuthorityScreen,
  type MobileWebShellScreenProps
} from './MobileWebShellAuthorityScreen'

export type { MobileWebShellScreenProps } from './MobileWebShellAuthorityScreen'

export function MobileWebShellScreen(props: MobileWebShellScreenProps) {
  const { clientId } = useHostClient(props.hostId)
  // Close the old bridge on commit before updated host props can reach its callbacks.
  const authority = deriveHostCacheKey(JSON.stringify([props.hostId, clientId]))
  return <MobileWebShellAuthorityScreen key={authority} {...props} authorityClientId={clientId} />
}
