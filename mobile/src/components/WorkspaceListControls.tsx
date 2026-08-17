// The Filter / Sort / Group trio above every workspace list. Shared so the phone
// toolbar, the tablet sidebar and the merged Projects home cannot drift apart.

import { Text, StyleSheet, Pressable } from 'react-native'
import { Filter, Layers, SlidersHorizontal } from 'lucide-react-native'
import { colors, spacing } from '../theme/mobile-theme'
import { groupModeLabel, type MobileGroupMode } from '../worktree/workspace-view-settings'

type Props = {
  /** 'compact' gives the chips equal widths for the narrow tablet sidebar. */
  layout: 'row' | 'compact'
  activeFilterCount: number
  sortLabel: string
  groupMode: MobileGroupMode
  onOpenFilter: () => void
  onOpenSort: () => void
  onOpenGroup: () => void
}

export function WorkspaceListControls({
  layout,
  activeFilterCount,
  sortLabel,
  groupMode,
  onOpenFilter,
  onOpenSort,
  onOpenGroup
}: Props): React.JSX.Element {
  const compact = layout === 'compact'
  const filtered = activeFilterCount > 0
  return (
    <>
      <Pressable
        style={[
          styles.filterChip,
          compact && styles.compactChip,
          filtered && styles.filterChipActive
        ]}
        onPress={onOpenFilter}
        accessibilityRole="button"
        accessibilityLabel={`Filter workspaces${filtered ? `, ${activeFilterCount} active` : ''}`}
      >
        <Filter size={12} color={filtered ? colors.textPrimary : colors.textSecondary} />
        <Text
          style={[styles.filterChipText, filtered && styles.filterChipTextActive]}
          numberOfLines={1}
        >
          {filtered ? `Filter ${activeFilterCount}` : 'Filter'}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.modeButton, compact && styles.compactChip]}
        onPress={onOpenSort}
        accessibilityRole="button"
        accessibilityLabel={`Sort by ${sortLabel}`}
      >
        <SlidersHorizontal size={14} color={colors.textSecondary} />
        <Text style={styles.modeLabel} numberOfLines={1}>
          {sortLabel}
        </Text>
      </Pressable>

      <Pressable
        style={[styles.modeButton, compact && styles.compactChip]}
        onPress={onOpenGroup}
        accessibilityRole="button"
        accessibilityLabel="Group workspaces"
      >
        <Layers size={14} color={colors.textSecondary} />
        <Text style={styles.modeLabel} numberOfLines={1}>
          {groupModeLabel(groupMode)}
        </Text>
      </Pressable>
    </>
  )
}

const styles = StyleSheet.create({
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.borderSubtle
  },
  filterChipActive: {
    borderColor: colors.textSecondary,
    backgroundColor: colors.bgRaised
  },
  filterChipText: {
    fontSize: 12,
    color: colors.textSecondary
  },
  filterChipTextActive: {
    color: colors.textPrimary
  },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    minWidth: 0,
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  modeLabel: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: 12,
    color: colors.textSecondary
  },
  compactChip: {
    flex: 1,
    minWidth: 0,
    height: 30,
    justifyContent: 'center',
    paddingHorizontal: spacing.xs,
    paddingVertical: 0
  }
})
