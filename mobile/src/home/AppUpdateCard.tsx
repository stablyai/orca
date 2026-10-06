import { ArrowUpFromLine, X } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing } from '../theme/mobile-theme'

/** Home's update notice, drawn in the host card's frame so it reads as part of that list. */
export function AppUpdateCard(props: {
  version: string
  onPress: () => void
  onDismiss: () => void
}) {
  const title = `Orca ${props.version} is available`
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, tap to update`}
        style={({ pressed }) => [styles.cardMain, pressed && styles.cardPressed]}
        onPress={props.onPress}
      >
        <View style={styles.icon}>
          <ArrowUpFromLine size={20} strokeWidth={1.75} color={colors.textPrimary} />
        </View>
        <View style={styles.main}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            Tap to update
          </Text>
        </View>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Dismiss Orca ${props.version} update`}
        hitSlop={8}
        style={({ pressed }) => [styles.dismissButton, pressed && styles.dismissPressed]}
        onPress={props.onDismiss}
      >
        <X size={16} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

// Same frame, icon well and spacing as MobileHostCard.
const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: radii.card,
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    overflow: 'hidden'
  },
  cardMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: spacing.md,
    paddingVertical: 12
  },
  cardPressed: { backgroundColor: colors.bgRaised },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginRight: 14
  },
  main: { flex: 1, minWidth: 0, marginRight: spacing.sm },
  title: { color: colors.textPrimary, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  subtitle: { color: colors.textSecondary, fontSize: 12, lineHeight: 16 },
  dismissButton: {
    width: 40,
    height: 40,
    marginHorizontal: spacing.xs,
    borderRadius: radii.row,
    alignItems: 'center',
    justifyContent: 'center'
  },
  dismissPressed: { backgroundColor: colors.bgRaised }
})
