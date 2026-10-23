import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { X } from 'lucide-react-native'
import { colors, spacing, textStyles } from '../../theme/mobile-theme'
import { IconButton } from './IconButton'

type SheetTextAction = { label: string; onPress: () => void; disabled?: boolean; busy?: boolean }

type SheetHeaderProps = {
  title: string
  subtitle?: string
  /** "Cancel" for a sheet that commits; omit for a plain list sheet. */
  leading?: SheetTextAction
  /** "Done" or the sheet's commit, in bold. */
  trailing?: SheetTextAction
  /** A close button instead of a text action, for sheets that only show things. */
  onClose?: () => void
  testID?: string
}

/** The one sheet header: 52 pt, centred 17 pt title, a text action or close on either side. */
export function SheetHeader({
  title,
  subtitle,
  leading,
  trailing,
  onClose,
  testID
}: SheetHeaderProps) {
  return (
    <View style={styles.header} testID={testID}>
      <View style={styles.side}>
        {leading ? <TextAction action={leading} emphasis={false} /> : null}
      </View>
      <View style={styles.center}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {title}
        </Text>
        {subtitle !== undefined ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={[styles.side, styles.trailing]}>
        {trailing ? <TextAction action={trailing} emphasis /> : null}
        {onClose && !trailing ? (
          <IconButton icon={X} accessibilityLabel="Close" onPress={onClose} iconSize={16} />
        ) : null}
      </View>
    </View>
  )
}

function TextAction({ action, emphasis }: { action: SheetTextAction; emphasis: boolean }) {
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled || action.busy}
      accessibilityRole="button"
      accessibilityLabel={action.label}
      accessibilityState={{ disabled: action.disabled === true, busy: action.busy === true }}
      style={({ pressed }) => [
        styles.action,
        pressed && styles.actionPressed,
        action.disabled && styles.actionDisabled
      ]}
    >
      {action.busy ? (
        <ActivityIndicator size="small" color={colors.textPrimary} />
      ) : (
        <Text style={[styles.actionLabel, emphasis && styles.actionEmphasis]} numberOfLines={1}>
          {action.label}
        </Text>
      )}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.xs
  },
  side: { width: 84, flexDirection: 'row', alignItems: 'center' },
  trailing: { justifyContent: 'flex-end' },
  center: { flex: 1, minWidth: 0, alignItems: 'center' },
  title: { ...textStyles.headline, color: colors.textPrimary },
  subtitle: { ...textStyles.footnote, color: colors.textSecondary },
  action: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: 22,
    justifyContent: 'center'
  },
  actionPressed: { backgroundColor: colors.fill },
  actionDisabled: { opacity: 0.4 },
  actionLabel: { ...textStyles.headline, fontWeight: '400', color: colors.textPrimary },
  actionEmphasis: { fontWeight: '600' }
})
