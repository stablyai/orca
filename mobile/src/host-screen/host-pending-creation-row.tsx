import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { SectionPendingCreation } from '../worktree/workspace-list-types'

export function HostPendingCreationRow({ creation }: { creation: SectionPendingCreation }) {
  return (
    <View style={styles.row} accessibilityRole="progressbar">
      <View style={styles.indicator}>
        <ActivityIndicator size="small" color={colors.textMuted} />
      </View>
      <View style={styles.main}>
        <Text style={styles.title} numberOfLines={1}>
          Creating workspace…
        </Text>
        {creation.repoName ? (
          <Text style={styles.meta} numberOfLines={1}>
            {creation.repoName}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  // Match the workspace row’s padding and indicator column so completion does not shift the row.
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent'
  },
  indicator: {
    width: 20,
    alignItems: 'center',
    marginRight: spacing.sm
  },
  main: {
    flex: 1
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textSecondary
  },
  meta: {
    marginTop: 2,
    color: colors.textMuted,
    fontSize: typography.metaSize
  }
})
