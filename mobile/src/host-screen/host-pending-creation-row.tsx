import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import type { SectionPendingCreation } from '../worktree/workspace-list-types'

/** A workspace the host is creating, where the desktop's sidebar shows its pending row. */
export function HostPendingCreationRow({
  creation,
  sidebar = false
}: {
  creation: SectionPendingCreation
  sidebar?: boolean
}) {
  return (
    <View style={[styles.row, sidebar && styles.rowSidebar]} accessibilityRole="progressbar">
      <View style={styles.leading}>
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
  // The workspace row's box and leading slot, so the finished row lands in place.
  row: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg
  },
  rowSidebar: {
    minHeight: 60,
    marginHorizontal: spacing.sm,
    paddingLeft: spacing.md
  },
  leading: { width: 28, alignItems: 'center' },
  main: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...textStyles.body, fontWeight: '500', color: colors.textSecondary },
  meta: { ...textStyles.subhead, color: colors.textMuted }
})
