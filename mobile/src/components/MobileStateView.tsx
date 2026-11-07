import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { CircleAlert, SearchX, WifiOff, type LucideIcon } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing, typography, pressedStyle } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { describeLoadError } from './load-error-description'

export type MobileStateAction = { label: string; onPress: () => void }

type MobileStateViewProps = {
  /** Omitted while loading, which shows a spinner instead. */
  icon?: LucideIcon
  /** A non-Lucide mark, such as a provider logo, drawn where the icon goes. */
  iconElement?: ReactNode
  title: string
  message?: string | null
  /** Raw text a person can open for support, never shown by default. */
  details?: string | null
  action?: MobileStateAction | null
  loading?: boolean
  /** Keeps the content centred above a floating bottom bar. */
  bottomInset?: number
}

/** Every screen's loading, empty, no-match, error and offline state: icon, title, one sentence, one action. */
export function MobileStateView({
  icon: Icon,
  iconElement,
  title,
  message,
  details,
  action,
  loading = false,
  bottomInset = 0
}: MobileStateViewProps) {
  useMobileColorScheme()
  return (
    <View style={[styles.state, { paddingBottom: spacing.xl + bottomInset }]}>
      {loading ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : Icon ? (
        <Icon size={24} color={colors.textMuted} strokeWidth={1.75} />
      ) : (
        iconElement
      )}
      <Text style={loading ? styles.message : styles.title}>{title}</Text>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {details ? <MobileStateDetails details={details} /> : null}
      {action ? <MobileStateButton label={action.label} onPress={action.onPress} /> : null}
    </View>
  )
}

/** The one action a centred state offers, such as Retry. */
export function MobileStateButton({ label, onPress }: MobileStateAction) {
  useMobileColorScheme()
  return (
    <Pressable
      style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
    >
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  )
}

function MobileStateDetails({ details }: { details: string }) {
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  return (
    <>
      <Pressable
        style={({ pressed }) => pressed && pressedStyle}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
      >
        <Text style={styles.detailsToggle}>
          {open ? t('common.hideDetails', 'Hide details') : t('common.details', 'Details')}
        </Text>
      </Pressable>
      {open ? (
        <Text style={styles.details} selectable>
          {details}
        </Text>
      ) : null}
    </>
  )
}

/** A failed load: the translated reason, raw text behind Details, and Retry when it can help. */
export function MobileLoadErrorState({
  error,
  title,
  onRetry,
  bottomInset
}: {
  error: unknown
  title?: string
  onRetry?: (() => void) | null
  bottomInset?: number
}) {
  const t = useMobileTranslation()
  const { message, details } = describeLoadError(error, t)
  return (
    <MobileStateView
      icon={CircleAlert}
      title={title ?? t('common.loadError.title', 'Unable to Load')}
      message={message}
      details={details}
      action={onRetry ? { label: t('common.retry', 'Retry'), onPress: onRetry } : null}
      bottomInset={bottomInset}
    />
  )
}

/** The host is unreachable and nothing is cached: say so and offer a reconnect. */
export function MobileOfflineState({
  hostName,
  onReconnect,
  bottomInset
}: {
  hostName?: string | null
  onReconnect?: (() => void) | null
  bottomInset?: number
}) {
  const t = useMobileTranslation()
  return (
    <MobileStateView
      icon={WifiOff}
      title={
        hostName
          ? t('common.offline.waitingFor', 'Waiting for {{host}}', { host: hostName })
          : t('common.offline.waiting', 'Waiting for desktop')
      }
      message={t(
        'common.offline.message',
        'Check that your computer is awake and Orca is running.'
      )}
      action={
        onReconnect
          ? { label: t('common.offline.reconnect', 'Reconnect'), onPress: onReconnect }
          : null
      }
      bottomInset={bottomInset}
    />
  )
}

/** A search or filter that matched nothing, with the way back out. */
export function MobileNoMatchState({
  message,
  onClear,
  clearLabel,
  bottomInset
}: {
  message?: string
  onClear?: (() => void) | null
  clearLabel?: string
  bottomInset?: number
}) {
  const t = useMobileTranslation()
  return (
    <MobileStateView
      icon={SearchX}
      title={t('common.noMatch.title', 'No matches')}
      message={message}
      action={
        onClear
          ? {
              label: clearLabel ?? t('common.noMatch.clearSearch', 'Clear search'),
              onPress: onClear
            }
          : null
      }
      bottomInset={bottomInset}
    />
  )
}

const styles = themedStyleSheet(() => ({
  state: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    gap: 6
  },
  title: {
    marginTop: spacing.xs,
    color: colors.textPrimary,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center'
  },
  message: {
    maxWidth: 280,
    color: colors.textSecondary,
    fontSize: 13,
    lineHeight: 17,
    textAlign: 'center'
  },
  detailsToggle: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    fontWeight: '600',
    paddingVertical: 2
  },
  details: {
    maxWidth: 300,
    color: colors.textMuted,
    fontSize: 11,
    lineHeight: 15,
    fontFamily: typography.monoFamily,
    textAlign: 'center'
  },
  action: {
    marginTop: spacing.sm,
    minHeight: 32,
    justifyContent: 'center',
    paddingHorizontal: 14,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  actionPressed: { opacity: feedback.pressedOpacity },
  actionText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: '600'
  }
}))
