import { View, Text, StyleSheet } from 'react-native'
import { SquareTerminal } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'

// Empty detail pane shown beside the worktree-list sidebar on wide
// tablet/foldable layouts until the user opens a workspace.
export function WorkspaceDetailPlaceholder() {
  return (
    <View style={styles.container}>
      <View style={styles.icon}>
        <SquareTerminal size={28} color={colors.textMuted} />
      </View>
      <Text style={styles.title}>No workspace open</Text>
      <Text style={styles.body}>Pick a workspace from the sidebar to open its terminal here.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    backgroundColor: colors.bgBase
  },
  icon: {
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgPanel,
    marginBottom: spacing.lg
  },
  title: {
    color: colors.textPrimary,
    fontSize: 16,
    fontWeight: '600',
    marginBottom: spacing.xs
  },
  body: {
    color: colors.textSecondary,
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 320
  }
})
