import type { ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import { ChevronLeft } from 'lucide-react-native'
import { NavBar } from '../components/nav-bar/NavBar'
import { NavBarButton, NavBarButtonOnSheetContext } from '../components/nav-bar/NavBarButton'
import { ListGroup, LIST_ROW_PADDING, SectionHeader } from '../components/list/ListGroup'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'

type SettingsNavBarProps = {
  title: string
  onBack: () => void
  /** At most two NavBarButtons. */
  trailing?: ReactNode
  /** Replaces the title, e.g. a title button that picks a computer. */
  center?: ReactNode
}

/** A settings screen's top bar: Back, the centred title, and up to two buttons. */
export function SettingsNavBar({ title, onBack, trailing, center }: SettingsNavBarProps) {
  const t = useMobileTranslation()
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  // The bar takes the grouped page's grey, so its buttons need the fill that reads on a grey sheet.
  return (
    <NavBarButtonOnSheetContext.Provider value>
      <NavBar
        style={settingsScreenStyles.bar}
        leading={
          <NavBarButton
            icon={ChevronLeft}
            accessibilityLabel={t('common.back', 'Back')}
            onPress={onBack}
          />
        }
        title={title}
        center={center}
        trailing={trailing}
      />
    </NavBarButtonOnSheetContext.Provider>
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
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
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
  trailing,
  children
}: {
  title?: string
  /** Beside the title, e.g. a compact action for the whole group. */
  trailing?: ReactNode
  /** Explains the group; a string becomes a note, anything else renders as is. */
  footer?: ReactNode
  /** The first section on the screen sits closer to the bar. */
  first?: boolean
  separatorInset?: number
  /** The rows are one pick-one choice. */
  radioGroup?: boolean
  children: ReactNode
}) {
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  return (
    <View
      style={!title && !first && settingsScreenStyles.untitledGap}
      accessibilityRole={radioGroup ? 'radiogroup' : undefined}
    >
      {title ? <SectionHeader title={title} first={first} trailing={trailing} /> : null}
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
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  return (
    <Text
      accessibilityRole={alert || error ? 'alert' : undefined}
      // Android announces newly shown text only through a live region.
      accessibilityLiveRegion={alert || error ? 'polite' : undefined}
      style={[settingsScreenStyles.note, error && settingsScreenStyles.noteError]}
    >
      {children}
    </Text>
  )
}

/** The only line in a group that has nothing to list yet, e.g. no paired desktops. */
export function SettingsEmptyRow({ children }: { children: ReactNode }) {
  const settingsScreenStyles = useThemedStyles(settingsScreenStylesSheet)
  return <Text style={settingsScreenStyles.emptyRow}>{children}</Text>
}

export const settingsScreenStylesSheet = themedStyleSheet((colors) => ({
  container: { flex: 1, backgroundColor: colors.groupedPage },
  bar: { backgroundColor: colors.groupedPage },
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
