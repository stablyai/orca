import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react-native'
import { Pressable, Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, feedback, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import type { Worktree } from '../worktree/workspace-list-types'

// Grows the 20 pt pill to a 44 pt target without pushing the row apart.
const LINEAGE_TOGGLE_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const

export function WorktreeLineageToggle({
  item,
  count,
  onToggle
}: {
  item: Worktree
  count: number
  onToggle: (item: Worktree) => void
}) {
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [styles.lineageToggle, pressed && styles.lineageTogglePressed]}
      hitSlop={LINEAGE_TOGGLE_HIT_SLOP}
      onPress={(event) => {
        event.stopPropagation()
        onToggle(item)
      }}
    >
      {item.lineageCollapsed ? (
        <ChevronRight size={12} color={colors.textSecondary} />
      ) : (
        <ChevronDown size={12} color={colors.textSecondary} />
      )}
      <GitBranch size={12} color={colors.textSecondary} />
      <Text style={styles.lineageToggleText}>
        {count === 1
          ? t('components.worktreeListRow.children_one', '{{count}} child', { count })
          : t('components.worktreeListRow.children_other', '{{count}} children', { count })}
      </Text>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  lineageToggle: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radii.control
  },
  lineageTogglePressed: {
    opacity: feedback.pressedOpacity
  },
  lineageToggleText: {
    fontSize: 11,
    color: colors.textSecondary,
    fontWeight: '600'
  }
}))
