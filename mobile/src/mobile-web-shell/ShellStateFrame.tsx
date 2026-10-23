import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { LucideIcon } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import { NavBar } from '../components/ui/NavBar'
import { Button } from '../components/ui/Button'

/**
 * Every screen that stands in for a workspace page: checking, downloading, offline, failed, route
 * unavailable and the version wall. The bar sits where the page's own bar will, so the hand-over
 * to the page keeps Back and the desktop's name in one place.
 */
export function ShellStateFrame({
  title,
  onBack,
  backAccessibilityLabel,
  children,
  testID
}: {
  /** The desktop's name; omitted while it is unknown. */
  title?: string
  onBack?: () => void
  backAccessibilityLabel?: string
  children: ReactNode
  testID?: string
}) {
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID={testID}
    >
      <NavBar title={title} onBack={onBack} backAccessibilityLabel={backAccessibilityLabel} />
      <View style={styles.body}>{children}</View>
    </View>
  )
}

type ShellStateAction = { label: string; onPress: () => void; testID?: string }

/**
 * StateView's layout with testIDs on its actions, which the shell's screens are found by.
 * TODO(design-system): drop once StateView's actions take a testID.
 */
export function ShellStateMessage({
  icon: Icon,
  title,
  message,
  primary,
  secondary,
  note,
  testID
}: {
  icon: LucideIcon
  title: string
  message?: string
  primary?: ShellStateAction
  secondary?: ShellStateAction
  /** A quieter line under the actions, e.g. what to do if this keeps showing. */
  note?: string
  testID?: string
}) {
  return (
    <View style={styles.message} testID={testID}>
      <Icon size={32} color={colors.textMuted} strokeWidth={1.75} />
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {message !== undefined ? <Text style={styles.text}>{message}</Text> : null}
      {primary || secondary ? (
        <View style={styles.actions}>
          {primary ? (
            <Button
              label={primary.label}
              onPress={primary.onPress}
              testID={primary.testID}
              variant="primary"
              size="compact"
            />
          ) : null}
          {secondary ? (
            <Button
              label={secondary.label}
              onPress={secondary.onPress}
              testID={secondary.testID}
              variant="plain"
              size="compact"
            />
          ) : null}
        </View>
      ) : null}
      {note !== undefined ? <Text style={styles.note}>{note}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bgBase },
  body: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl + 16,
    // Lifts the centre a little above the screen's middle, where the eye expects it under a bar.
    paddingBottom: 52
  },
  message: { width: '100%', maxWidth: 320, alignItems: 'center', gap: 10 },
  title: {
    ...textStyles.title,
    fontSize: 20,
    lineHeight: 25,
    color: colors.textPrimary,
    textAlign: 'center',
    marginTop: 6
  },
  text: { ...textStyles.callout, color: colors.textSecondary, textAlign: 'center' },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm
  },
  note: {
    ...textStyles.footnote,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm
  }
})
