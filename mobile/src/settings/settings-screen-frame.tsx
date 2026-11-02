import type { ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { ListGroup, LIST_ROW_PADDING, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type SettingsNavBarProps = {
  title: string
  onBack: () => void
  /** At most two NavBarButtons. */
  trailing?: ReactNode
}

/** A settings screen's top bar: Back, the centred title, and up to two buttons. */
export function SettingsNavBar({ title, onBack, trailing }: SettingsNavBarProps) {
  const t = useMobileTranslation()
  return (
    <NavBar
      leading={
        <NavBarButton
          icon={ChevronLeft}
          accessibilityLabel={t('common.back', 'Back')}
          onPress={onBack}
        />
      }
      title={title}
      trailing={trailing}
    />
  )
}

/** A native settings screen: the bar inside the top safe area, then scrolling grouped sections. */
export function SettingsScreen({
  title,
  onBack,
  trailing,
  children,
  overlays,
  fillContent = false
}: SettingsNavBarProps & {
  children: ReactNode
  /** Lets a centred loading or empty state fill the space under the bar. */
  fillContent?: boolean
  /** Sheets and pickers, kept outside the scroll view so their backdrop covers the screen. */
  overlays?: ReactNode
}) {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  return (
    <SafeAreaView style={settingsScreenStyles.container} edges={['top']}>
      <SettingsNavBar title={title} onBack={onBack} trailing={trailing} />
      <ScrollView
        contentContainerStyle={[
          settingsScreenStyles.scrollContent,
          fillContent && settingsScreenStyles.fill,
          { paddingBottom: insets.bottom + spacing.xl }
        ]}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {overlays}
    </SafeAreaView>
  )
}

/** A labelled group of rows, with an optional note under it. */
export function SettingsSection({
  title,
  footer,
  first = false,
  separatorInset,
  radioGroup = false,
  children
}: {
  title?: string
  /** Explains the group; a string becomes a note, anything else renders as is. */
  footer?: ReactNode
  /** The first section on the screen sits closer to the bar. */
  first?: boolean
  separatorInset?: number
  /** The rows are one pick-one choice. */
  radioGroup?: boolean
  children: ReactNode
}) {
  return (
    <View
      style={!title && !first && settingsScreenStyles.untitledGap}
      accessibilityRole={radioGroup ? 'radiogroup' : undefined}
    >
      {title ? <SectionHeader title={title} first={first} /> : null}
      <ListGroup separatorInset={separatorInset}>{children}</ListGroup>
      {typeof footer === 'string' ? <SettingsNote>{footer}</SettingsNote> : footer}
    </View>
  )
}

/** Grey explanatory text lined up with the row text; `alert` announces it, `error` also turns it red. */
export function SettingsNote({
  children,
  alert = false,
  error = false
}: {
  children: ReactNode
  alert?: boolean
  error?: boolean
}) {
  useMobileColorScheme()
  return (
    <Text
      accessibilityRole={alert || error ? 'alert' : undefined}
      style={[settingsScreenStyles.note, error && settingsScreenStyles.noteError]}
    >
      {children}
    </Text>
  )
}

/** The only line in a group that has nothing to list yet, e.g. no paired desktops. */
export function SettingsEmptyRow({ children }: { children: ReactNode }) {
  useMobileColorScheme()
  return <Text style={settingsScreenStyles.emptyRow}>{children}</Text>
}

export const settingsScreenStyles = themedStyleSheet(() => ({
  container: { flex: 1, backgroundColor: colors.bgBase },
  scrollContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
  fill: { flexGrow: 1 },
  untitledGap: { marginTop: spacing.lg },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.textSecondary,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingTop: spacing.sm
  },
  noteError: { color: colors.statusRed },
  emptyRow: {
    fontSize: 15,
    color: colors.textSecondary,
    paddingHorizontal: LIST_ROW_PADDING,
    paddingVertical: spacing.md
  }
}))
