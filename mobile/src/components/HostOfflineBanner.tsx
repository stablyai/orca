import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { CloudOff } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useCalmConnectionState } from '../transport/connection/calm-connection-state'
import { formatOfflineAsOfTime } from './offline-as-of-time'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'

/** The banner's state for a screen that shows data, or null while it should stay hidden. */
export function useHostOfflineBanner({
  client,
  connState,
  lastConnectedAt,
  outage,
  forceReconnect,
  hasData,
  asOf
}: {
  client: RpcClient | null
  connState: ConnectionState
  lastConnectedAt: number | null
  /** The screen's verdict that the host can't be reached; the client keeps redialing either way. */
  outage: boolean
  /** Rebuilds the connection where this document owns it; a page in the app shell can only nudge it. */
  forceReconnect: (() => void) | null
  hasData: boolean
  /** When the shown data was read from the host, which may be an earlier launch's. */
  asOf: number | null
}): { offline: boolean; asOf: number | null; retry: (() => void) | null } | null {
  const state = useCalmConnectionState(connState, lastConnectedAt)
  // Data this document read stayed live until the connection dropped; stored data only until it was read.
  const [mountedAt] = useState(Date.now)
  const [droppedAt, setDroppedAt] = useState<number | null>(null)
  useEffect(() => {
    let previous = client?.getState()
    return client?.onStateChange((next) => {
      if (next === 'connected') {
        setDroppedAt(null)
      } else if (previous === 'connected') {
        setDroppedAt(Date.now())
      }
      previous = next
    })
  }, [client])
  // Before a first connect, such as a relaunch over stored rows, the header's refresh line covers
  // connecting and the banner waits until the host is judged unreachable.
  const show =
    hasData &&
    state !== 'connected' &&
    state !== 'auth-failed' &&
    (lastConnectedAt !== null || outage)
  if (!show) {
    return null
  }
  // A nudge redials now instead of waiting out the reconnect backoff.
  const retry = forceReconnect ?? (client ? () => client.notifyForeground('focus') : null)
  const readThisDocument = asOf !== null && asOf >= mountedAt
  return {
    offline: outage || state === 'disconnected',
    asOf: readThisDocument ? (droppedAt ?? asOf) : asOf,
    retry
  }
}

/**
 * Inset at the top of a screen that still shows data while its desktop is unreachable.
 * Offline offers Retry; otherwise it is still redialing. An empty screen says it in its body instead.
 */
export function HostOfflineBanner({
  hostName,
  offline,
  asOf,
  onRetry
}: {
  hostName: string
  offline: boolean
  /** When the shown data was read from the host. */
  asOf: number | null
  onRetry: (() => void) | null
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.banner} accessibilityLiveRegion="polite">
      {offline ? (
        <CloudOff size={18} color={colors.statusAmber} />
      ) : (
        <ActivityIndicator size="small" color={colors.textSecondary} style={styles.spinner} />
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {offline
            ? t('components.hostOfflineBanner.offline', '{{host}} is offline', { host: hostName })
            : t('components.hostOfflineBanner.reconnecting', 'Reconnecting to {{host}}…', {
                host: hostName
              })}
        </Text>
        {asOf !== null ? (
          <Text style={styles.detail} numberOfLines={1}>
            {t('components.hostOfflineBanner.asOf', 'Showing what was here as of {{time}}', {
              time: formatOfflineAsOfTime(asOf)
            })}
          </Text>
        ) : null}
      </View>
      {offline && onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.retry, pressed && pressedStyle]}
          onPress={onRetry}
          accessibilityRole="button"
        >
          <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    borderRadius: radii.surface,
    backgroundColor: colors.bgRaised,
    borderWidth: 0.5,
    borderColor: colors.statusAmber
  },
  spinner: {
    width: 18,
    height: 18
  },
  text: {
    flex: 1,
    minWidth: 0
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  },
  detail: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  retry: {
    height: 32,
    paddingHorizontal: 11,
    borderRadius: radii.control,
    backgroundColor: colors.translucentFill,
    justifyContent: 'center'
  },
  retryText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textPrimary
  }
}))
