import { StyleSheet, Text, View } from 'react-native'
import { colors, radii, textStyles } from '../theme/mobile-theme'
import { workspaceOptionsBadgeText } from '../worktree/workspace-options-copy'

/** The active-filter count on the options button's corner, as on the desktop trigger. */
export function WorkspaceOptionsCountBadge({ count }: { count: number }) {
  const text = workspaceOptionsBadgeText(count)
  if (text === null) {
    return null
  }
  return (
    <View style={styles.badge} pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <Text style={styles.badgeText}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    // Why: a ring in the canvas colour keeps the badge off the button's circle.
    borderWidth: 2,
    borderColor: colors.bgBase
  },
  badgeText: {
    ...textStyles.caption,
    fontWeight: '600',
    color: colors.onPrimary,
    fontVariant: ['tabular-nums']
  }
})
