import { Pressable, StyleSheet, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, Pin } from 'lucide-react-native'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import type { Section } from '../worktree/workspace-list-types'
import { MobileRepoIcon } from './MobileRepoIcon'
import { colors, spacing } from '../theme/mobile-theme'

type WorkspaceSectionHeaderProps = {
  section: Section
  collapsed: boolean
  count: number
  // Repo grouping shows the project icon beside the title; other modes pass undefined.
  repoBadge?: { icon: RepoIcon | null; color: string | null }
  onToggle: (key: string) => void
}

export function WorkspaceSectionHeader({
  section,
  collapsed,
  count,
  repoBadge,
  onToggle
}: WorkspaceSectionHeaderProps) {
  if (!section.title) {
    return null
  }
  return (
    <Pressable
      style={styles.sectionHeader}
      onPress={() => onToggle(section.key)}
      accessibilityRole="button"
      accessibilityLabel={section.title}
      accessibilityState={{ expanded: !collapsed }}
    >
      {collapsed ? (
        <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
      ) : (
        <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
      )}
      {section.icon === 'pin' && (
        <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
      )}
      {repoBadge ? (
        <View style={styles.sectionRepoIcon}>
          <MobileRepoIcon
            repoIcon={repoBadge.icon}
            size={14}
            color={repoBadge.color ?? colors.textSecondary}
          />
        </View>
      ) : null}
      <Text style={styles.sectionTitle}>{section.title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs
  },
  sectionIcon: {
    marginRight: spacing.xs
  },
  sectionRepoIcon: {
    marginRight: spacing.xs
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5
  },
  sectionCount: {
    fontSize: 11,
    color: colors.textMuted,
    marginLeft: spacing.xs
  }
})
