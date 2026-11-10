import { memo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, FolderTree, Pin } from 'lucide-react-native'
import { DisclosureChevron } from '../components/DisclosureChevron'
import { MobileRepoIcon } from '../components/MobileRepoIcon'
import { WORKTREE_ROW_LAYOUT } from '../components/worktree-list-row-layout'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { projectGroupHeaderIndent } from '../worktree/project-group-indent'
import type { Section } from '../worktree/workspace-list-types'
import type { RepoLook } from './host-repo-looks'
import { hostScreenStyles as styles } from './host-screen-styles'
import { HostPendingCreationRow } from './host-pending-creation-row'
import type { HostScreenController } from './use-host-screen-controller'

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
  pinRepo?: Section['repo']
  pinLabel: string
  projectPinned: boolean
  onToggleProjectPin: HostScreenController['settings']['toggleProjectPin']
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
        {props.pinRepo ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.pinLabel}
            hitSlop={8}
            onPress={(event) => {
              event.stopPropagation()
              if (props.pinRepo) {
                void props.onToggleProjectPin(props.pinRepo)
              }
            }}
          >
            <Pin size={14} color={props.projectPinned ? colors.textPrimary : colors.textMuted} />
          </Pressable>
        ) : null}
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
