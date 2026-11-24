import { Text, View } from 'react-native'
import { CloudOff } from 'lucide-react-native'
import { useHostOfflineBanner } from '../components/host-connection/HostOfflineBanner'
import { LoadingSpinner } from '../components/feedback/LoadingSpinner'
import { LIST_ROW_PADDING } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useClientState } from '../query/host-mutation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotTextButton } from './MobileBotTextButton'

/** One quiet line under a Settings page's header while the host can't be reached, as on the desktop. */
export function MobileBotSettingsOffline(props: { hostName: string; client: RpcClient | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
  const host = props.hostName
  return (
    <View style={styles.line} accessibilityLiveRegion="polite">
      {banner.offline ? (
        <CloudOff size={14} color={colors.textMuted} />
      ) : (
        <LoadingSpinner size={14} color={colors.textMuted} />
      )}
      <Text style={styles.text} numberOfLines={1}>
        {banner.offline
          ? t('bots.page.serverDownTitle', 'Can’t reach {{host}}', { host })
          : t('components.hostOfflineBanner.reconnecting', 'Reconnecting to {{host}}…', { host })}
      </Text>
      {banner.offline && banner.retry ? (
        <MobileBotTextButton label={t('common.retry', 'Retry')} accent onPress={banner.retry} />
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: LIST_ROW_PADDING,
    // Retry's own inset brings its label to the rows' trailing edge.
    paddingRight: LIST_ROW_PADDING - spacing.xs,
    paddingVertical: spacing.sm
  },
  text: { flex: 1, minWidth: 0, fontSize: 13, color: colors.textSecondary }
}))
