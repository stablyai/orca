import { Plus, QrCode, type LucideIcon } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../transport/types'

/** Home's New workspace action, pinned within thumb reach above the home indicator. */
export function MobileHomeBottomBar(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  connectedHosts: HostProfile[]
  /** A desktop is still on its first connect; the "connect first" note waits so it cannot flash at launch. */
  hostsConnecting: boolean
  onCreateWorkspace: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const enabled = props.connectedHosts.length > 0
  return (
    <MobileHomeBottomBarFrame {...props}>
      {enabled || props.hostsConnecting ? null : (
        <Text style={styles.note}>
          {t('home.bottomBar.connectFirst', 'Connect a desktop to start new work.')}
        </Text>
      )}
      <View style={styles.buttons}>
        <BarButton
          icon={Plus}
          label={t('home.bottomBar.newWorkspace', 'New workspace')}
          disabled={!enabled}
          onPress={props.onCreateWorkspace}
        />
      </View>
    </MobileHomeBottomBarFrame>
  )
}

/** First run's single action, in the same pinned spot. */
export function MobileHomePairBar(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  onPairDesktop: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <MobileHomeBottomBarFrame {...props}>
      <View style={styles.buttons}>
        <BarButton
          icon={QrCode}
          label={t('home.emptyState.pairDesktopButton', 'Pair desktop')}
          onPress={props.onPairDesktop}
        />
      </View>
    </MobileHomeBottomBarFrame>
  )
}

function MobileHomeBottomBarFrame(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  children: ReactNode
}) {
  useMobileColorScheme()
  return (
    <View style={[styles.bar, { paddingBottom: props.bottomInset + spacing.sm }]}>
      <View
        style={
          props.isWideLayout
            ? { maxWidth: props.contentMaxWidth, width: '100%', alignSelf: 'center' }
            : null
        }
      >
        {props.children}
      </View>
    </View>
  )
}

function BarButton(props: {
  icon: LucideIcon
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const Icon = props.icon
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.button,
        pressed && styles.buttonPressed,
        props.disabled && styles.buttonDisabled
      ]}
      onPress={props.onPress}
    >
      <Icon size={19} color={colors.bgBase} strokeWidth={2.2} />
      <Text style={styles.buttonLabel} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    backgroundColor: colors.bgBase,
    borderTopWidth: 1,
    borderTopColor: colors.borderSubtle,
    paddingTop: 10,
    paddingHorizontal: spacing.lg
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    textAlign: 'center',
    marginBottom: 10
  },
  buttons: { flexDirection: 'row', gap: 10 },
  button: {
    flex: 1,
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.control,
    backgroundColor: colors.surfaceBright
  },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { fontSize: 17, fontWeight: '600', color: colors.bgBase }
}))
