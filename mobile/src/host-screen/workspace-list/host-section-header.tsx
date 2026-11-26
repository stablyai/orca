import { memo } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'
import { ChevronRight, FolderTree, Pin, Plus } from 'lucide-react-native'
import { DisclosureChevron } from '../../components/list/DisclosureChevron'
import { MobileRepoIcon } from '../../components/icons/MobileRepoIcon'
import { colors, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { worktreeListRowStyles as rowStyles } from '../../worktree/row-presentation/worktree-list-row-styles'
import type { Section } from '../../worktree/workspace-list/workspace-list-types'
import { hostScreenStyles as styles } from '../host-screen-styles'
import type { RepoLook } from '../catalog/host-repo-looks'
import { HostPendingCreationRow } from './host-pending-creation-row'
import { projectGroupHeaderIndent } from '../../worktree/project-sections/project-group-indent'

// Header 34 pt tall; this grows its target to 44 without moving the text.
const HEADER_HIT_SLOP = { top: 5, bottom: 5 } as const
const ADD_HIT_SLOP = { top: 5, bottom: 5, left: 4, right: 4 } as const

// Takes the header's own fields, not the section, so a poll that rebuilds sections skips unchanged headers.
export const HostSectionHeader = memo(function HostSectionHeader(props: {
  title: string
  icon: Section['icon']
  isProjectGroup: boolean | undefined
  projectGroupDepth: number | undefined
  pendingCreations: Section['pendingCreations']
  /** The first section rows follow: its pending rows round the group's top instead. */
  hasRows: boolean
  collapseKey: string
  collapsed: boolean
  count: number
  pending: boolean
  groupByRepo: boolean
  repoLook: RepoLook | null | undefined
  /** No header sits above it, so it sits closer to the page title. */
  first: boolean
  onToggle: (collapseKey: string) => void
  /** New workspace in this project; absent when one can't start from here. */
  onNew?: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const creations = props.pendingCreations ?? []
  const pendingCreations = creations.map((creation, index) => (
    <View key={creation.key}>
      {index > 0 ? (
        <View style={rowStyles.groupSeparator}>
          <View style={rowStyles.groupSeparatorLine} />
        </View>
      ) : null}
      <View
        style={[
          rowStyles.groupRow,
          index === 0 && rowStyles.groupFirst,
          index === creations.length - 1 && !props.hasRows && rowStyles.groupLast
        ]}
      >
        <HostPendingCreationRow creation={creation} />
      </View>
      {index === creations.length - 1 && props.hasRows ? (
        <View style={rowStyles.groupSeparator}>
          <View style={rowStyles.groupSeparatorLine} />
        </View>
      ) : null}
    </View>
  ))
  if (!props.title) {
    return creations.length > 0 ? <>{pendingCreations}</> : null
  }
  const indent = projectGroupHeaderIndent(props.projectGroupDepth)
  return (
    <>
      <View
        style={[
          styles.sectionHeader,
          props.first && styles.sectionHeaderFirst,
          indent > 0 && { paddingLeft: spacing.xs + indent }
        ]}
      >
        <Pressable
          style={({ pressed }) => [styles.sectionToggle, pressed && styles.sectionTogglePressed]}
          hitSlop={HEADER_HIT_SLOP}
          accessibilityRole="button"
          accessibilityState={{ expanded: !props.collapsed }}
          aria-expanded={!props.collapsed}
          accessibilityLabel={`${props.title}, ${props.count}`}
          onPress={() => props.onToggle(props.collapseKey)}
        >
          {props.icon === 'pin' ? (
            <Pin size={16} color={colors.textMuted} />
          ) : props.groupByRepo && props.isProjectGroup ? (
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
          {props.pending ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
          <View style={styles.sectionSpacer} />
        </Pressable>
        {props.onNew ? (
          <Pressable
            style={({ pressed }) => [styles.sectionAdd, pressed && styles.sectionTogglePressed]}
            hitSlop={ADD_HIT_SLOP}
            accessibilityRole="button"
            accessibilityLabel={t(
              'hostScreen.hostSectionHeader.newWorkspaceIn',
              'New workspace in {{project}}',
              { project: props.title }
            )}
            onPress={props.onNew}
          >
            <Plus size={18} color={colors.textMuted} />
          </Pressable>
        ) : null}
        <Pressable
          style={styles.sectionChevron}
          hitSlop={ADD_HIT_SLOP}
          importantForAccessibility="no"
          accessibilityElementsHidden
          onPress={() => props.onToggle(props.collapseKey)}
        >
          <DisclosureChevron expanded={!props.collapsed} collapsedDeg={0} expandedDeg={90}>
            <ChevronRight size={16} color={colors.textMuted} />
          </DisclosureChevron>
        </Pressable>
      </View>
      {pendingCreations}
    </>
  )
})
