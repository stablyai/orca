import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import {
  selectHostWorkspaceListState,
  type HostWorkspaceListStateInput
} from './host-workspace-list-state'

export function HostWorkspaceListStates(
  props: HostWorkspaceListStateInput & {
    search: string
    activeFilterCount: number
  }
) {
  const state = selectHostWorkspaceListState(props)
  if (state === 'loading') {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" color={colors.textSecondary} />
      </View>
    )
  }
  if (state === 'catalog-error') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>Could not load workspaces from this host</Text>
        <Text style={styles.catalogErrorDetail}>
          {`worktree.ps failed (${props.catalogError}) — retrying automatically`}
        </Text>
      </View>
    )
  }
  if (state === 'empty') {
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>
          {props.search
            ? 'No matching worktrees'
            : props.activeFilterCount > 0
              ? 'No worktrees match filters'
              : 'No worktrees'}
        </Text>
      </View>
    )
  }
  return null
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  emptyText: {
    color: colors.textSecondary,
    fontSize: typography.bodySize
  },
  catalogErrorDetail: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.lg,
    color: colors.textMuted,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
})
