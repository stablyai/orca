import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { CloudOff } from '../icons/app-icons'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { LoadingSpinner } from '../feedback/LoadingSpinner'
import { LIST_ROW_PADDING } from '../list/ListGroup'
import { colors, pressedStyle, spacing, typography } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useCalmConnectionState } from '../../transport/connection/calm-connection-state'
import { formatOfflineAsOfTime } from './offline-as-of-time'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'

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
 * A quiet line at the top of a screen that still shows data while its desktop is unreachable, as on the desktop.
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
    <View style={styles.line} accessibilityLiveRegion="polite">
      {offline ? (
        <CloudOff size={14} color={colors.textMuted} />
      ) : (
        <LoadingSpinner size={14} color={colors.textMuted} />
      )}
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {offline
            ? t('components.hostOfflineBanner.offline', 'Can’t reach {{host}}', { host: hostName })
            : t('components.hostOfflineBanner.reconnecting', 'Reconnecting to {{host}}…', {
                host: hostName
              })}
        </Text>
        {asOf !== null ? (
          <Text style={styles.detail} numberOfLines={1}>
            {t('components.hostOfflineBanner.asOf', 'As of {{time}}', {
              time: formatOfflineAsOfTime(asOf)
            })}
          </Text>
        ) : null}
      </View>
      {offline && onRetry ? (
        <Pressable
          style={({ pressed }) => [styles.retry, pressed && pressedStyle]}
          onPress={onRetry}
          hitSlop={RETRY_HIT_SLOP}
          accessibilityRole="button"
        >
          <Text style={styles.retryText}>{t('common.retry', 'Retry')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const RETRY_HIT_SLOP = { top: 8, bottom: 8 }
// The text keeps Retry's height so the line doesn't jump when Retry comes and goes.
const LINE_CONTENT_HEIGHT = 32

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
  text: {
    flex: 1,
    minWidth: 0,
    minHeight: LINE_CONTENT_HEIGHT,
    justifyContent: 'center'
  },
  title: {
    fontSize: 13,
    color: colors.textSecondary
  },
  detail: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  retry: {
    minHeight: LINE_CONTENT_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs
  },
  retryText: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.accentBlue
  }
}))
