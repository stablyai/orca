import { StyleSheet, Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { workspaceOptionsBadgeText } from '../worktree/workspace-options-copy'

/** The active-filter count in the chip's corner, as on the desktop trigger (the chip must not clip). */
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
    top: -5,
    right: -5,
    minWidth: 14,
    height: 14,
    paddingHorizontal: 3,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.textPrimary
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '600',
    color: colors.bgBase
  }
})
