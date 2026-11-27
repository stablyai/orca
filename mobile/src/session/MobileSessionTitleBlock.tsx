import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { TailClippedText } from '../components/list/TailClippedText'
import { StatusDot } from '../components/feedback/StatusDot'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { ConnectionVerdict } from '../transport/connection/connection-health'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { MobileForkMarkedName } from './fork/MobileForkMarkedName'
import { isPathTitle } from './tabs/mobile-session-tab-rows'

/** The top bar's title: the open tab with its mark, and the workspace (or what's wrong with the connection) under it. */
export function MobileSessionTitleBlock({
  title,
  forked = false,
  leading,
  subtitle,
  status,
  accessibilityLabel,
  onPress,
  showConnectionRetry,
  onRetry
}: {
  title: string
  /** The title names a forked chat, drawn after the fork mark. */
  forked?: boolean
  /** Before the title: the tab's mark, or a bot's avatar. */
  leading?: ReactNode
  subtitle: string
  /** The connection's dot, shown only while something is wrong with it. */
  status: { state: ConnectionState; verdict?: ConnectionVerdict } | null
  accessibilityLabel: string
  /** Opens the open tab's actions; absent with no tab open. */
  onPress?: () => void
  showConnectionRetry: boolean
  onRetry: () => void
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const subtitleRow = (
    <>
      {status ? <StatusDot state={status.state} verdict={status.verdict} /> : null}
      <Text style={styles.subtitle} numberOfLines={1}>
        {subtitle}
      </Text>
    </>
  )
  // Reconnect is a sibling of the title action: screen readers drop a control nested in another.
  return (
    <View style={styles.block}>
      <Pressable
        style={({ pressed }) => [
          styles.titleAction,
          !showConnectionRetry && styles.titleActionFull,
          pressed && onPress && pressedStyle
        ]}
        onPress={onPress}
        disabled={!onPress}
        accessibilityRole={onPress ? 'button' : 'header'}
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={
          onPress ? t('session.tabBar.actionsHint', 'Shows actions for this tab') : undefined
        }
      >
        <View style={styles.titleRow}>
          {leading ? <View style={styles.leading}>{leading}</View> : null}
          {forked ? (
            <Text style={styles.title} numberOfLines={1}>
              <MobileForkMarkedName name={title} />
            </Text>
          ) : isPathTitle(title) ? (
            <View style={styles.pathTitle}>
              <TailClippedText style={styles.title}>{title}</TailClippedText>
            </View>
          ) : (
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          )}
        </View>
        {showConnectionRetry ? null : <View style={styles.subtitleRow}>{subtitleRow}</View>}
      </Pressable>
      {showConnectionRetry ? (
        <Pressable
          style={({ pressed }) => [styles.subtitleRow, pressed && pressedStyle]}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel={t('session.header.reconnectToDesktop', 'Reconnect to desktop')}
        >
          {subtitleRow}
        </Pressable>
      ) : null}
    </View>
  )
}

// NavBar's title and subtitle, so the session bar reads like every other screen's.
const stylesSheet = themedStyleSheet((colors) => ({
  block: { maxWidth: '100%', minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  titleAction: { maxWidth: '100%', alignItems: 'center' },
  // Without a reconnect row the title action keeps the whole 44 pt bar.
  titleActionFull: { minHeight: 44, justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  // Keeps web SVGs from shrinking before the title ellipsizes.
  leading: { flexShrink: 0 },
  title: { flexShrink: 1, minWidth: 0, color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  pathTitle: { flexShrink: 1, minWidth: 0 },
  subtitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minWidth: 0,
    maxWidth: '100%'
  },
  subtitle: { flexShrink: 1, color: colors.textSecondary, fontSize: 12 }
}))
