import type { ReactNode } from 'react'
import { ScrollView, Text, View } from 'react-native'
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  NATIVE_SCREEN_HEADER,
  ScreenHeader,
  type ScreenHeaderProps
} from '../components/nav-bar/ScreenHeader'
import { ListGroup, LIST_ROW_PADDING, SectionHeader } from '../components/list/ListGroup'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type SettingsHeaderProps = Pick<ScreenHeaderProps, 'title' | 'onBack' | 'actions' | 'largeTitle'>

/** A settings screen's header, for screens that lay out their own body. */
export function SettingsNavBar(props: SettingsHeaderProps) {
  return <ScreenHeader {...props} />
}

/** A settings screen: its header, then scrolling grouped sections. */
export function SettingsScreen({
  title,
  onBack,
  actions,
  largeTitle,
  children,
  overlays,
  fillContent = false
}: SettingsHeaderProps & {
  children: ReactNode
  /** Lets a centred loading or empty state fill the space under the bar. */
  fillContent?: boolean
  /** Sheets and pickers, kept outside the scroll view so their backdrop covers the screen. */
  overlays?: ReactNode
}) {
  useMobileColorScheme()
  const insets = useSafeAreaInsets()
  return (
    <SafeAreaView
      style={settingsScreenStyles.container}
      edges={NATIVE_SCREEN_HEADER ? [] : ['top']}
    >
      <ScreenHeader title={title} onBack={onBack} actions={actions} largeTitle={largeTitle} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
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
