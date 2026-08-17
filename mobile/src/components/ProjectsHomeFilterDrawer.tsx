// Filter sheet for the merged Projects home. Mirrors the per-host list's sheet and
// adds the execution-host section, which only a cross-desktop list can offer.

import { View, Text, StyleSheet, Pressable } from 'react-native'
import { Check } from 'lucide-react-native'
import { colors, spacing, typography } from '../theme/mobile-theme'
import type { ExecutionHostFilterOption } from '../worktree/merged-desktop-workspaces'
import type { FilterState } from '../worktree/workspace-list-types'
import { BottomDrawer } from './BottomDrawer'

type Props = {
  visible: boolean
  filters: FilterState
  executionHostOptions: readonly ExecutionHostFilterOption[]
  activeFilterCount: number
  onToggleHideSleeping: () => void
  onToggleHideDefaultBranch: () => void
  onToggleExecutionHost: (hostId: string) => void
  onClearFilters: () => void
  onClose: () => void
}

export function ProjectsHomeFilterDrawer({
  visible,
  filters,
  executionHostOptions,
  activeFilterCount,
  onToggleHideSleeping,
  onToggleHideDefaultBranch,
  onToggleExecutionHost,
  onClearFilters,
  onClose
}: Props): React.JSX.Element {
  const selectedHostIds = filters.filterExecutionHostIds
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <View style={styles.header}>
        <Text style={styles.title}>Filter</Text>
        {activeFilterCount > 0 ? (
          <Pressable onPress={onClearFilters} accessibilityRole="button">
            <Text style={styles.clearText}>Clear filters</Text>
          </Pressable>
        ) : null}
      </View>

      <Text style={styles.sectionLabel}>Workspaces</Text>
      <View style={styles.group}>
        <Pressable style={styles.row} onPress={onToggleHideSleeping} accessibilityRole="button">
          <Text style={styles.rowText}>Hide sleeping</Text>
          {filters.hideSleeping ? <Check size={14} color={colors.textPrimary} /> : null}
        </Pressable>
        <View style={styles.separator} />
        <Pressable
          style={styles.row}
          onPress={onToggleHideDefaultBranch}
          accessibilityRole="button"
        >
          <Text style={styles.rowText}>Hide default branch</Text>
          {filters.hideDefaultBranch ? <Check size={14} color={colors.textPrimary} /> : null}
        </Pressable>
      </View>

      {/* One host means the section can only be a no-op or a way to empty the list. */}
      {executionHostOptions.length > 1 ? (
        <>
          <Text style={styles.sectionLabel}>Hosts</Text>
          <View style={styles.group}>
            {executionHostOptions.map((option, index) => (
              <View key={option.id}>
                {index > 0 ? <View style={styles.separator} /> : null}
                <Pressable
                  style={styles.row}
                  onPress={() => onToggleExecutionHost(option.id)}
                  accessibilityRole="button"
                >
                  <Text style={styles.rowText} numberOfLines={1}>
                    {option.label}
                  </Text>
                  <Text style={styles.rowCount}>{option.count}</Text>
                  {selectedHostIds?.has(option.id) ? (
                    <Check size={14} color={colors.textPrimary} />
                  ) : null}
                </Pressable>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
    marginBottom: spacing.md
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary
  },
  clearText: {
    fontSize: 13,
    color: colors.textSecondary
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  group: {
    backgroundColor: colors.bgPanel,
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2,
    gap: spacing.sm
  },
  rowText: {
    flex: 1,
    fontSize: typography.bodySize,
    color: colors.textPrimary
  },
  rowCount: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.borderSubtle,
    marginHorizontal: spacing.md
  }
})
