import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { isConnectionOutage, verdictDisplayLabel } from '../transport/connection-health'
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
  if (state === 'unreachable') {
    const { connectionVerdict } = props
    return (
      <View style={styles.centered}>
        <Text style={styles.emptyText}>{verdictDisplayLabel(connectionVerdict)}</Text>
        <Text style={styles.catalogErrorDetail}>
          {(isConnectionOutage(connectionVerdict) ? connectionVerdict.detail : undefined) ??
            'Check that your computer is awake and Orca is running'}
        </Text>
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
            ? 'No matching workspaces'
            : props.activeFilterCount > 0
              ? 'No workspaces match filters'
              : 'No workspaces'}
        </Text>
      </View>
    )
  }
  return null
}

/** A list this page cannot build; shown above the rows it already holds, so it never blanks. */
export function HostWorkspaceListReopen({ aboveRows }: { aboveRows: boolean }) {
  return (
    <View style={aboveRows ? styles.aboveRows : styles.centered}>
      <Text style={styles.emptyText}>Reopen to update</Text>
      <Text style={styles.catalogErrorDetail}>
        This host lists workspaces in a way this page does not know yet.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  aboveRows: {
    alignItems: 'center',
    paddingVertical: spacing.md
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
