import {
  HostOfflineBanner,
  useHostOfflineBanner
} from '../components/host-connection/HostOfflineBanner'
import { useClientState } from '../query/host-mutation'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

/** The offline line under a Settings page's header while the host can't be reached. */
export function MobileBotSettingsOffline(props: { hostName: string; client: RpcClient | null }) {
  const { client } = props
  const banner = useHostOfflineBanner({
    client,
    connState: useClientState(client),
    lastConnectedAt: client?.getLastConnectedAt() ?? null,
    outage: false,
    forceReconnect: null,
    hasData: true,
    asOf: null
  })
  if (!banner) {
    return null
  }
  return (
    <HostOfflineBanner
      hostName={props.hostName}
      offline={banner.offline}
      asOf={null}
      onRetry={banner.retry}
    />
  )
}
