import { memo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import { DisclosureChevron } from '../../components/list/DisclosureChevron'
import { MobileRepoIcon } from '../../components/icons/MobileRepoIcon'
import { WORKTREE_ROW_LAYOUT } from '../../worktree/row-presentation/worktree-list-row-layout'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import type { Section } from '../../worktree/workspace-list/workspace-list-types'
import { hostScreenStylesSheet } from '../host-screen-styles'
import type { RepoLook } from '../catalog/host-repo-looks'
import { HostPendingCreationRow } from './host-pending-creation-row'
import { projectGroupHeaderIndent } from '../../worktree/project-sections/project-group-indent'
import { useThemedStyles } from '../../theme/themed-styles'

// Takes the header's own fields, not the section, so a poll that rebuilds sections skips unchanged headers.
export const HostSectionHeader = memo(function HostSectionHeader(props: {
  title: string
  icon: Section['icon']
  isProjectGroup: boolean | undefined
  projectGroupDepth: number | undefined
  pendingCreations: Section['pendingCreations']
  collapseKey: string
  collapsed: boolean
  count: number
  pending: boolean
  groupByRepo: boolean
  repoLook: RepoLook | null | undefined
  onToggle: (collapseKey: string) => void
}) {
  const styles = useThemedStyles(hostScreenStylesSheet)
  const colors = useMobileColors()
  const pendingCreations = props.pendingCreations?.map((creation) => (
    <HostPendingCreationRow key={creation.key} creation={creation} />
  ))
  if (!props.title) {
    return pendingCreations ? <>{pendingCreations}</> : null
  }
  return (
    <>
      <Pressable
        style={({ pressed }) => [
          styles.sectionHeader,
          props.projectGroupDepth
            ? {
                paddingLeft:
                  WORKTREE_ROW_LAYOUT.indicatorInset +
                  projectGroupHeaderIndent(props.projectGroupDepth)
              }
            : null,
          pressed && { backgroundColor: colors.translucentFill }
        ]}
        onPress={() => props.onToggle(props.collapseKey)}
      >
        <View style={styles.sectionChevron}>
          <DisclosureChevron expanded={!props.collapsed} collapsedDeg={0} expandedDeg={90}>
            <ChevronRight size={12} color={colors.textMuted} />
          </DisclosureChevron>
        </View>
        {props.icon === 'pin' && (
          <Pin size={12} color={colors.textMuted} style={styles.sectionIcon} />
        )}
        {props.groupByRepo && props.isProjectGroup ? (
          <FolderTree size={12} color={colors.textPrimary} style={styles.sectionIcon} />
        ) : props.groupByRepo ? (
          <View style={styles.sectionRepoIcon}>
            <MobileRepoIcon
              repoIcon={props.repoLook?.icon ?? null}
              size={14}
              color={props.repoLook?.color ?? colors.textSecondary}
            />
          </View>
        ) : null}
        <Text style={styles.sectionTitle}>{props.title}</Text>
        <Text style={styles.sectionCount}>{props.count}</Text>
        {props.pending && (
          <ActivityIndicator
            size="small"
            color={colors.textMuted}
            style={styles.sectionPendingSpinner}
          />
        )}
      </Pressable>
      {pendingCreations}
    </>
  )
})
