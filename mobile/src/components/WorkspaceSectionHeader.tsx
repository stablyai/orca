// Collapsible group header for workspace lists (per-host and merged Projects home).

import { View, Text, StyleSheet, Pressable } from 'react-native'
import { ChevronDown, ChevronRight, Pin } from 'lucide-react-native'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { colors, spacing } from '../theme/mobile-theme'
import { MobileRepoIcon } from './MobileRepoIcon'

type Props = {
  title: string
  /** Row count before collapsing, so a collapsed group still shows its size. */
  count: number
  collapsed: boolean
  pinnedGroup?: boolean
  /** Set when grouping by repo; the header then leads with the repo's icon. */
  repoIcon?: RepoIcon | null
  repoColor?: string | null
  onToggle: () => void
}

export function WorkspaceSectionHeader({
  title,
  count,
  collapsed,
  pinnedGroup = false,
  repoIcon,
  repoColor,
  onToggle
}: Props): React.JSX.Element {
  const showRepoIcon = repoIcon !== undefined || repoColor != null
  return (
    <Pressable
      style={styles.sectionHeader}
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: !collapsed }}
      accessibilityLabel={`${title}, ${count} workspace${count === 1 ? '' : 's'}`}
    >
      {collapsed ? (
        <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
      ) : (
        <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
      )}
      {pinnedGroup ? <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} /> : null}
      {showRepoIcon ? (
        <View style={styles.sectionIcon}>
          <MobileRepoIcon
            repoIcon={repoIcon ?? null}
            size={14}
            color={repoColor ?? colors.textSecondary}
          />
        </View>
      ) : null}
      <Text style={styles.sectionTitle}>{title}</Text>
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
