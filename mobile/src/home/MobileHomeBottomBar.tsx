import { CalendarClock, ListTodo, Plus, QrCode, type LucideIcon } from 'lucide-react-native'
import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { PickerModal } from '../components/PickerModal'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { HostProfile } from '../transport/types'

/** Home's actions, pinned within thumb reach above the home indicator. */
export function MobileHomeBottomBar(props: {
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  connectedHosts: HostProfile[]
  onOpenTasks: (hostId: string) => void
  onOpenAutomations: (hostId: string) => void
  onCreateWorkspace: () => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  const automationsHostPicker = useConnectedHostPicker(props.connectedHosts)
  const enabled = props.connectedHosts.length > 0
  return (
    <MobileHomeBottomBarFrame {...props}>
      {enabled ? null : (
        <Text style={styles.note}>
          {t('home.bottomBar.connectFirst', 'Connect a desktop to start new work.')}
        </Text>
      )}
      <View style={styles.buttons}>
        <BarButton
          icon={ListTodo}
          label={t('home.bottomBar.tasks', 'Tasks')}
          variant="secondary"
          disabled={!enabled}
          onPress={() => tasksHostPicker.pickHost(props.onOpenTasks)}
        />
        <BarButton
          icon={CalendarClock}
          label={t('home.listFooter.automationsHeading', 'Automations')}
          variant="secondary"
          disabled={!enabled}
          onPress={() => automationsHostPicker.pickHost(props.onOpenAutomations)}
        />
        <BarButton
          icon={Plus}
          label={t('home.bottomBar.newWorkspace', 'New workspace')}
          variant="primary"
          disabled={!enabled}
          onPress={props.onCreateWorkspace}
        />
      </View>
      <PickerModal
        title={t('home.listFooter.hostPickerTitle', 'Open Tasks On')}
        {...tasksHostPicker.pickerProps}
      />
      <PickerModal
        title={t('home.listFooter.automationsHostPickerTitle', 'Open Automations On')}
        {...automationsHostPicker.pickerProps}
      />
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
          variant="primary"
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
  variant: 'primary' | 'secondary'
  disabled?: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const primary = props.variant === 'primary'
  const foreground = primary ? colors.bgBase : colors.textPrimary
  const Icon = props.icon
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.button,
        primary ? styles.primaryButton : styles.secondaryButton,
        pressed && styles.buttonPressed,
        props.disabled && styles.buttonDisabled
      ]}
      onPress={props.onPress}
    >
      <Icon size={19} color={foreground} strokeWidth={2.2} />
      <Text style={[styles.buttonLabel, { color: foreground }]} numberOfLines={1}>
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
    borderRadius: radii.control
  },
  primaryButton: { backgroundColor: colors.surfaceBright },
  secondaryButton: { backgroundColor: colors.bgRaised },
  buttonPressed: { opacity: 0.72, transform: [{ scale: 0.98 }] },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { fontSize: 17, fontWeight: '600' }
}))
