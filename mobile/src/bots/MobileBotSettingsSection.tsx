import type { ReactNode } from 'react'
import { Text, View } from 'react-native'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import {
  HostOfflineBanner,
  useHostOfflineBanner
} from '../components/host-connection/HostOfflineBanner'
import { useClientState } from '../query/host-mutation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { optionStyles } from './mobile-bot-option-styles'

export function MobileBotSettingsSection({
  title,
  detail,
  children
}: {
  title: string
  detail?: string
  children: ReactNode
}) {
  return (
    <View>
      <SectionHeader title={title} />
      {detail ? (
        <Text style={[optionStyles.optionRowDetail, optionStyles.optionPageTitle]}>{detail}</Text>
      ) : null}
      <ListGroup>{children}</ListGroup>
    </View>
  )
}

/** Under a Settings page's header while the host can't be reached; its settings are read-only until it is back. */
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
  return banner ? (
    <View style={styles.offline}>
      <HostOfflineBanner
        hostName={props.hostName}
        offline={banner.offline}
        asOf={null}
        onRetry={banner.retry}
      />
    </View>
  ) : null
}

const styles = themedStyleSheet(() => ({
  offline: { marginVertical: spacing.sm }
}))
