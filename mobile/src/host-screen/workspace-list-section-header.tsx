import { Pressable, Text, View } from 'react-native'
import { ChevronDown, ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import type { RepoIcon } from '../../../src/shared/repo-icon'
import { MobileRepoIcon } from '../components/MobileRepoIcon'
import { colors, spacing } from '../theme/mobile-theme'
import type {
  WorkspaceListSectionIcon,
  WorkspaceListSectionKind
} from '../worktree/workspace-list-types'
import { hostScreenStyles as styles } from './host-screen-styles'

export function WorkspaceListSectionHeader(props: {
  title: string
  count: number
  depth: number
  kind: WorkspaceListSectionKind
  icon?: WorkspaceListSectionIcon
  collapsed: boolean
  repoColor: string | null
  repoIcon: RepoIcon | null
  onPress: () => void
}) {
  const { title, count, depth, kind, icon, collapsed, repoColor, repoIcon, onPress } = props
  return (
    <Pressable
      style={[styles.sectionHeader, { paddingLeft: spacing.lg + depth * spacing.lg }]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${count}`}
      accessibilityState={{ expanded: !collapsed }}
    >
      {collapsed ? (
        <ChevronRight size={12} color={colors.textMuted} style={styles.sectionIcon} />
      ) : (
        <ChevronDown size={12} color={colors.textMuted} style={styles.sectionIcon} />
      )}
      {icon === 'pin' && <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />}
      {icon === 'folder' && (
        <FolderTree size={12} color={colors.textMuted} style={styles.sectionIcon} />
      )}
      {kind === 'repo' ? (
        <View style={styles.sectionRepoIcon}>
          <MobileRepoIcon repoIcon={repoIcon} size={14} color={repoColor ?? colors.textSecondary} />
        </View>
      ) : null}
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </Pressable>
  )
}
