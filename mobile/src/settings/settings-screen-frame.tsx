import { useState, type ReactNode } from 'react'
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ArrowUpRight, type LucideIcon } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { NavBar } from '../components/ui/NavBar'
import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { MobileSwitch } from '../components/MobileSwitch'
import { triggerSelection } from '../platform/haptics'

/** Settings-like screens stop growing here, so rows stay readable on an iPad. */
export const SETTINGS_CONTENT_MAX_WIDTH = 720

type SettingsScreenProps = {
  title: string
  subtitle?: string
  /** Defaults to popping the stack. */
  onBack?: () => void
  backAccessibilityLabel?: string
  trailing?: ReactNode
  children: ReactNode
  /** False for a screen whose own content fills the height, such as a log. */
  scrollable?: boolean
  keyboardShouldPersistTaps?: 'always' | 'handled' | 'never'
  testID?: string
}

/** Every native settings-like screen: one nav bar at one height, then content inset for the bars. */
export function SettingsScreen({
  title,
  subtitle,
  onBack,
  backAccessibilityLabel,
  trailing,
  children,
  scrollable = true,
  keyboardShouldPersistTaps,
  testID
}: SettingsScreenProps) {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [scrolled, setScrolled] = useState(false)
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrolled(event.nativeEvent.contentOffset.y > 0)
  }
  return (
    <View style={[styles.root, { paddingTop: insets.top }]} testID={testID}>
      <NavBar
        title={title}
        subtitle={subtitle}
        onBack={onBack ?? (() => router.back())}
        backAccessibilityLabel={backAccessibilityLabel}
        trailing={trailing}
        scrolled={scrolled || !scrollable}
      />
      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xl }]}
          showsVerticalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        >
          <View style={styles.column}>{children}</View>
        </ScrollView>
      ) : (
        <View style={[styles.fixed, { paddingBottom: insets.bottom + spacing.sm }]}>
          <View style={[styles.column, styles.fixedColumn]}>{children}</View>
        </View>
      )}
    </View>
  )
}

type SettingsSectionProps = {
  /** Sentence case; omit for a group that needs no label. */
  title?: string
  /** One short line under the group. */
  footer?: string
  /** The first section under the bar sits closer to it. */
  first?: boolean
  /** Hairline start; rows with a leading icon pass `LIST_LEADING_INSET`. */
  separatorInset?: number
  action?: ReactNode
  children: ReactNode
}

/** A labelled inset group with an optional one-line footer. */
export function SettingsSection({
  title,
  footer,
  first = false,
  separatorInset,
  action,
  children
}: SettingsSectionProps) {
  return (
    <View style={!title && !first ? styles.untitledSection : undefined}>
      {title ? <SectionHeader title={title} first={first} action={action} /> : null}
      <ListGroup separatorInset={separatorInset}>{children}</ListGroup>
      {footer ? <SettingsFooter>{footer}</SettingsFooter> : null}
    </View>
  )
}

/** The line under a group: what the rows above it do, in one sentence. */
export function SettingsFooter({ children, tone }: { children: ReactNode; tone?: SettingsTone }) {
  return (
    <Text style={[styles.footer, tone && { color: SETTINGS_TONE_COLOR[tone] }]}>{children}</Text>
  )
}

export type SettingsTone = 'neutral' | 'success' | 'warning' | 'error'

export const SETTINGS_TONE_COLOR: Record<SettingsTone, string> = {
  neutral: colors.textMuted,
  success: colors.statusGreen,
  warning: colors.statusAmber,
  error: colors.danger
}

type SettingsSwitchRowProps = {
  title: string
  subtitle?: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  accessibilityLabel?: string
  leading?: ReactNode
  testID?: string
  subtitleNumberOfLines?: number
}

/** A row whose only control is a switch; the switch carries the row's label for screen readers. */
export function SettingsSwitchRow({
  title,
  subtitle,
  value,
  onValueChange,
  disabled = false,
  accessibilityLabel,
  leading,
  testID,
  subtitleNumberOfLines = 2
}: SettingsSwitchRowProps) {
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      leading={leading}
      subtitleNumberOfLines={subtitleNumberOfLines}
      accessory={
        <MobileSwitch
          value={value}
          onValueChange={(next) => {
            triggerSelection()
            onValueChange(next)
          }}
          disabled={disabled}
          accessibilityLabel={accessibilityLabel ?? title}
          testID={testID}
        />
      }
    />
  )
}

/** A row's leading glyph at the size rows use. */
export function SettingsRowIcon({ icon: Icon, color }: { icon: LucideIcon; color?: string }) {
  return <Icon size={19} color={color ?? colors.textSecondary} strokeWidth={2} />
}

/** Trailing mark for a row that leaves the app. */
export function ExternalLinkAccessory() {
  return <ArrowUpRight size={16} color={colors.textMuted} strokeWidth={2.2} />
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgBase },
  scroll: { flex: 1 },
  content: { paddingTop: spacing.xs },
  column: { width: '100%', maxWidth: SETTINGS_CONTENT_MAX_WIDTH, alignSelf: 'center' },
  fixed: { flex: 1, paddingTop: spacing.xs },
  fixedColumn: { flex: 1 },
  untitledSection: { marginTop: spacing.xl },
  footer: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.sm
  }
})
