import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { CloudOff } from 'lucide-react-native'
import { getUiIntlLocale } from '../i18n/ui-intl-locale'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, pressedStyle, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useCalmConnectionState } from '../transport/calm-connection-state'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'

/** The banner's state for a screen that shows data, or null while it should stay hidden. */
export function useHostOfflineBanner({
  client,
  connState,
  lastConnectedAt,
  outage,
  forceReconnect,
  hasData
}: {
  client: RpcClient | null
  connState: ConnectionState
  lastConnectedAt: number | null
  /** The screen's verdict that the host can't be reached; the client keeps redialing either way. */
  outage: boolean
  /** Rebuilds the connection where this document owns it; a page in the app shell can only nudge it. */
  forceReconnect: (() => void) | null
  hasData: boolean
}): { offline: boolean; asOf: number | null; retry: (() => void) | null } | null {
  const state = useCalmConnectionState(connState, lastConnectedAt)
  const show = hasData && state !== 'connected' && state !== 'auth-failed'
  // Live data stopped when the connection dropped; a screen that mounts offline shows the last connect.
  const [droppedAt, setDroppedAt] = useState<number | null>(() =>
    connState === 'connected' ? null : lastConnectedAt
  )
  useEffect(
    () =>
      client?.onStateChange((next) =>
        setDroppedAt((held) => (next === 'connected' ? null : (held ?? Date.now())))
      ),
    [client]
  )
  if (!show) {
    return null
  }
  // A nudge redials now instead of waiting out the reconnect backoff.
  const retry = forceReconnect ?? (client ? () => client.notifyForeground('focus') : null)
  return { offline: outage || state === 'disconnected', asOf: droppedAt, retry }
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
  /** When the shown data was last live. */
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
              time: new Intl.DateTimeFormat(getUiIntlLocale(), {
                hour: 'numeric',
                minute: '2-digit'
              }).format(asOf)
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
