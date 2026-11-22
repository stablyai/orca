import { memo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import { DisclosureChevron } from '../../components/list/DisclosureChevron'
import { MobileRepoIcon } from '../../components/icons/MobileRepoIcon'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { Section } from '../../worktree/workspace-list/workspace-list-types'
import { hostScreenStyles as styles } from '../host-screen-styles'
import type { RepoLook } from '../catalog/host-repo-looks'
import { HostPendingCreationRow } from './host-pending-creation-row'
import { projectGroupHeaderIndent } from '../../worktree/project-sections/project-group-indent'

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
  /** No header sits above it, so it sits closer to the page title. */
  first: boolean
  onToggle: (collapseKey: string) => void
}) {
  useMobileColorScheme()
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
          props.first && styles.sectionHeaderFirst,
          props.projectGroupDepth
            ? { paddingLeft: projectGroupHeaderIndent(props.projectGroupDepth) }
            : null,
          pressed && { backgroundColor: colors.translucentFill }
        ]}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        aria-expanded={!props.collapsed}
        onPress={() => props.onToggle(props.collapseKey)}
      >
        {props.icon === 'pin' && <Pin size={16} color={colors.textMuted} />}
        {props.groupByRepo && props.isProjectGroup ? (
          <FolderTree size={16} color={colors.textSecondary} />
        ) : props.groupByRepo ? (
          <MobileRepoIcon
            repoIcon={props.repoLook?.icon ?? null}
            size={16}
            color={props.repoLook?.color ?? colors.textSecondary}
          />
        ) : null}
        <Text style={styles.sectionTitle} numberOfLines={1}>
          {props.title}
        </Text>
        <Text style={styles.sectionCount}>{props.count}</Text>
        {props.pending && (
          <ActivityIndicator
            size="small"
            color={colors.textMuted}
            style={styles.sectionPendingSpinner}
          />
        )}
        <View style={styles.sectionSpacer} />
        <DisclosureChevron expanded={!props.collapsed} collapsedDeg={0} expandedDeg={90}>
          <ChevronRight size={16} color={colors.textMuted} />
        </DisclosureChevron>
      </Pressable>
      {pendingCreations}
    </>
  )
})
