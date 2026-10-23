import type { ComponentProps, ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Banner } from '../components/ui/Banner'
import { SheetHeader } from '../components/ui/SheetHeader'
import { colors, spacing, textStyles } from '../theme/mobile-theme'

/** SheetHeader pulled out to the sheet's edges, the way PickerModal places it. */
export function MobileTasksSheetHeader(props: ComponentProps<typeof SheetHeader>) {
  return (
    <View style={sheetStyles.header}>
      <SheetHeader {...props} />
    </View>
  )
}

/** A failure from this sheet's own action, shown in the sheet rather than behind its backdrop. */
export function MobileTasksSheetError({
  error,
  onDismiss
}: {
  error: string
  onDismiss: () => void
}) {
  if (!error) {
    return null
  }
  return (
    <View style={sheetStyles.banner}>
      <Banner tone="error" message={error} onDismiss={onDismiss} />
    </View>
  )
}

/** A footnote under a group, e.g. why an action is unavailable. */
export function MobileTasksSheetFootnote({ children }: { children: ReactNode }) {
  return <Text style={sheetStyles.footnote}>{children}</Text>
}

export const sheetStyles = StyleSheet.create({
  header: {
    marginHorizontal: -spacing.sm,
    marginTop: -spacing.xs,
    marginBottom: spacing.xs
  },
  // The sheet pads 12; groups add 4 so rows sit 16 from the sheet's edge.
  group: { marginHorizontal: spacing.xs },
  groupSpaced: { marginHorizontal: spacing.xs, marginBottom: spacing.lg },
  banner: { marginHorizontal: -spacing.sm, marginBottom: spacing.md },
  footnote: {
    ...textStyles.footnote,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg + 4,
    paddingTop: spacing.sm
  },
  form: { gap: spacing.lg, paddingHorizontal: spacing.xs },
  actions: {
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingTop: spacing.lg
  },
  loading: { minHeight: 120 },
  dot: { width: 10, height: 10, borderRadius: 5 }
})
