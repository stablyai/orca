import { Text, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { workspaceOptionsBadgeText } from '../worktree/workspace-options-copy'

/* Keep the trigger unclipped so the corner badge remains visible. */
export function WorkspaceOptionsCountBadge({ count }: { count: number }) {
  useMobileColorScheme()
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

const styles = themedStyleSheet(() => ({
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
}))
