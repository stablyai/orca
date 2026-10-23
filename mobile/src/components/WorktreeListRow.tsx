import { memo } from 'react'
import {
  Bell,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitPullRequest,
  SquareTerminal
} from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { triggerMediumImpact } from '../platform/haptics'
import { colors, MIN_TOUCH_TARGET, radii, spacing, textStyles } from '../theme/mobile-theme'
import type { Worktree } from '../worktree/workspace-list-types'
import type { WorktreeCardDetails } from '../../../src/shared/worktree/card-properties'
import { isRemoteExecutionHostId } from '../../../src/shared/execution-host'
import type { AgentActivityDisplayMode } from '../../../src/shared/ui-chrome-types'
import { areStructurallyEqual } from '../worktree/structural-equality'
import { projectGroupRowIndent } from '../worktree/project-group-indent'
import { getWorktreeMetaGlyphPresence } from '../worktree/worktree-meta-glyph-presence'
import { AgentSpinner } from './AgentSpinner'
import { HostKindIcon } from './HostKindIcon'
import { MobileRepoIcon } from './MobileRepoIcon'
import { WorktreeAgentList } from './WorktreeAgentList'
import { WorktreeMetaGlyphs } from './WorktreeMetaGlyphs'
import { Badge, type BadgeTone } from './ui/Badge'
import { pressTransition, slideTransition } from './ui/transition-styles'

// Strip the refs/heads/ prefix for display, matching the desktop sidebar
// (WorktreeCardHelpers.formatBranchName).
function displayBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

type WorktreeRollupStatus = 'working' | 'active' | 'permission' | 'done' | 'inactive'

type Props = {
  item: Worktree
  isReadOnly: boolean
  now: number
  repoColor: string
  repoIcon?: MobileRenderableRepoIcon | null
  // When the list is already grouped under this repo's section header, the row
  // omits its own repo icon+name to avoid the redundant "📁 orca" on every row.
  hideRepo?: boolean
  /** What the desktop's shared Card layout and properties show, and where identity goes. */
  cardDetails: WorktreeCardDetails
  agentActivityDisplayMode: AgentActivityDisplayMode
  status: WorktreeRollupStatus
  onPress: (item: Worktree) => void
  onAgentPress?: (item: Worktree, paneKey: string) => void
  statusLive?: boolean
  onLongPress?: (item: Worktree) => void
  onToggleLineage?: (item: Worktree) => void
  /** `sidebar` draws the wide layout's inset rows with a rounded selection, as an iPad sidebar. */
  appearance?: 'list' | 'sidebar'
}

// A quiet capsule in the review's state tone; draft stays neutral.
function prBadgeTone(state: string): BadgeTone {
  if (state === 'merged') {
    return 'purple'
  }
  if (state === 'open') {
    return 'green'
  }
  if (state === 'closed') {
    return 'red'
  }
  return 'neutral'
}

function WorktreeListRowComponent({
  item,
  isReadOnly,
  now,
  repoColor,
  repoIcon,
  hideRepo = false,
  cardDetails,
  agentActivityDisplayMode,
  status,
  onPress,
  onAgentPress,
  statusLive,
  onLongPress,
  onToggleLineage,
  appearance = 'list'
}: Props) {
  const sidebar = appearance === 'sidebar'
  const isFolderWorkspace = item.workspaceKind === 'folder-workspace'
  const name = item.displayName || item.repo
  const folderMeta = item.comment?.trim() || item.path || ''
  const metaText = isFolderWorkspace ? folderMeta : displayBranch(item.branch)
  const lineageDepth = Math.max(0, item.lineageDepth ?? 0)
  const indent = projectGroupRowIndent(item) + lineageDepth * 18
  const lineageChildCount = item.lineageChildCount ?? 0
  const shouldHideRepo = hideRepo && !item.showProjectName
  const showRepoChip = cardDetails.repoInTitle && !shouldHideRepo && !isFolderWorkspace
  const showRepoInMetaRow = !cardDetails.repoInTitle && !shouldHideRepo
  const hostId = item.hostContextHostId ?? item.hostId
  const hostAccessibilityLabel = [item.hostContextLabel, item.hostContextHealthLabel]
    .filter(Boolean)
    .join(', ')
  const showAgents = cardDetails.inlineAgents && item.agents !== undefined && item.agents.length > 0
  // One grey line says what is happening: the agents when they run, else where the workspace is.
  const identityParts = [
    // Health shows even under a host section header, where the name itself would repeat it.
    cardDetails.host && (item.hostContextLabel || item.hostContextHealthLabel)
      ? [item.hostContextLabel, item.hostContextHealthLabel].filter(Boolean).join(' ')
      : null,
    showRepoInMetaRow ? item.repo : null,
    isFolderWorkspace ? 'Folder' : null,
    metaText && metaText !== name ? metaText : null
  ].filter((part): part is string => Boolean(part))
  const identityLine = cardDetails.metaRow && !showAgents
  const identityText = identityParts.length > 0 ? identityParts.join(' · ') : 'No agents running'
  // Why: with the identity line gone, a remote workspace still shows where it runs.
  const showHostGlyph = (!cardDetails.metaRow || showAgents) && isRemoteExecutionHostId(hostId)
  const pr = cardDetails.pr ? item.linkedPR : null

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        identityLine || showAgents ? styles.rowTwoLine : styles.rowOneLine,
        sidebar && styles.rowSidebar,
        { paddingLeft: (sidebar ? spacing.md : spacing.lg) + indent },
        item.isActive && (sidebar ? styles.rowSelectedSidebar : styles.rowActive),
        pressed && (item.isActive ? styles.rowPressedActive : styles.rowPressed),
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
      disabled={isReadOnly}
      onPress={() => onPress(item)}
      onLongPress={
        onLongPress
          ? () => {
              triggerMediumImpact()
              onLongPress(item)
            }
          : undefined
      }
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityLabel={[name, lineageDepth > 0 ? 'child workspace' : null]
        .filter(Boolean)
        .join(', ')}
      accessibilityHint={onLongPress ? 'Touch and hold for actions' : undefined}
      accessibilityState={{
        disabled: isReadOnly,
        selected: item.isActive === true
      }}
    >
      <View style={styles.leading}>
        <AgentSpinner status={status} workingMode={item.workingMode} />
        {item.unread && (
          <View style={styles.unreadBell} accessibilityLabel="Unread">
            <Bell size={11} color={colors.statusAmber} fill={colors.statusAmber} />
          </View>
        )}
      </View>

      <View style={styles.main}>
        <View style={styles.titleLine}>
          {showHostGlyph && (
            <View accessibilityLabel={hostAccessibilityLabel || 'Remote host'}>
              <HostKindIcon hostId={hostId} size={14} />
            </View>
          )}
          {showRepoChip && (
            <View style={styles.repoChip} accessibilityLabel={`Project ${item.repo}`}>
              <MobileRepoIcon repoIcon={repoIcon} size={13} color={repoColor} />
            </View>
          )}
          <Text
            style={[
              styles.name,
              item.unread && styles.nameUnread,
              isReadOnly && styles.textReadOnly
            ]}
            numberOfLines={1}
          >
            {name}
          </Text>
          <WorktreeMetaGlyphs presence={getWorktreeMetaGlyphPresence(item, cardDetails)} />
        </View>
        {identityLine ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {identityText}
          </Text>
        ) : null}
        {/* Only agents get a secondary activity line, matching desktop. A plain
            terminal's shell-output tail is intentionally not surfaced here. */}
        {showAgents && item.agents ? (
          <WorktreeAgentList
            agents={item.agents}
            now={now}
            unvisited={item.unread}
            statusLive={statusLive}
            isReadOnly={isReadOnly}
            onAgentPress={onAgentPress ? (paneKey) => onAgentPress(item, paneKey) : undefined}
            fullList={agentActivityDisplayMode === 'full'}
          />
        ) : null}
        {lineageChildCount > 0 && onToggleLineage ? (
          <LineageToggle
            count={lineageChildCount}
            collapsed={item.lineageCollapsed === true}
            onPress={() => onToggleLineage(item)}
          />
        ) : null}
      </View>

      <View style={styles.trailing}>
        {pr ? (
          <Badge label={String(pr.number)} icon={GitPullRequest} tone={prBadgeTone(pr.state)} />
        ) : null}
        {isFolderWorkspace && !identityLine ? <Badge label="Folder" /> : null}
        {item.liveTerminalCount > 0 ? (
          <View
            accessibilityLabel={`${item.liveTerminalCount} live ${
              item.liveTerminalCount === 1 ? 'terminal' : 'terminals'
            }`}
          >
            <Badge label={String(item.liveTerminalCount)} icon={SquareTerminal} />
          </View>
        ) : null}
        <ChevronRight size={16} color={colors.textMuted} strokeWidth={2.2} />
      </View>
    </Pressable>
  )
}

/** "2 child workspaces": a 44 pt disclosure under the row that shows or hides its children. */
function LineageToggle({
  count,
  collapsed,
  onPress
}: {
  count: number
  collapsed: boolean
  onPress: () => void
}) {
  const label = `${count} child ${count === 1 ? 'workspace' : 'workspaces'}`
  return (
    <Pressable
      style={({ pressed }) => [
        styles.lineageToggle,
        pressed && styles.lineageTogglePressed,
        pressed ? pressTransition.pressed : pressTransition.rest
      ]}
      onPress={(event) => {
        event.stopPropagation()
        onPress()
      }}
      accessibilityRole="button"
      accessibilityLabel={`${collapsed ? 'Show' : 'Hide'} ${label}`}
      accessibilityState={{ expanded: !collapsed }}
    >
      <View
        style={[collapsed ? styles.chevronClosed : styles.chevronOpen, slideTransition]}
        pointerEvents="none"
      >
        <ChevronDown size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </View>
      <GitBranch size={14} color={colors.textSecondary} strokeWidth={2.2} />
      <Text style={styles.lineageToggleText}>{label}</Text>
    </Pressable>
  )
}

export const WorktreeListRow = memo(WorktreeListRowComponent, areStructurallyEqual)

// The title line's height, so the dot and the trailing badges centre on the name.
const TITLE_LINE = textStyles.headline.lineHeight

const styles = StyleSheet.create({
  row: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingRight: spacing.lg
  },
  rowTwoLine: { minHeight: 64 },
  rowOneLine: { alignItems: 'center' },
  rowSidebar: {
    marginHorizontal: spacing.sm,
    paddingRight: spacing.md,
    borderRadius: radii.field
  },
  rowPressed: { backgroundColor: colors.fill },
  // The workspace focused on the desktop, mirroring the desktop sidebar's selected card.
  rowActive: { backgroundColor: colors.fill },
  rowSelectedSidebar: { backgroundColor: colors.fillPressed },
  rowPressedActive: { backgroundColor: colors.fillPressed },
  leading: {
    width: 28,
    minHeight: TITLE_LINE,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  unreadBell: { position: 'absolute', top: TITLE_LINE, alignItems: 'center' },
  main: {
    flex: 1,
    minWidth: 0,
    gap: 2
  },
  titleLine: {
    minHeight: TITLE_LINE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  // A content list's title, as in Mail: 17 semibold over a 15 pt grey line, so the name leads.
  name: {
    ...textStyles.headline,
    color: colors.textPrimary,
    flexShrink: 1
  },
  nameUnread: { color: colors.primary },
  textReadOnly: { opacity: 0.5 },
  subtitle: { ...textStyles.callout, color: colors.textSecondary },
  // Why: matches the desktop's compact repo chip, a small framed icon ahead of the title.
  repoChip: {
    width: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.fill,
    flexShrink: 0
  },
  trailing: {
    minHeight: TITLE_LINE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexShrink: 0
  },
  lineageToggle: {
    alignSelf: 'flex-start',
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: -spacing.sm,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.field
  },
  lineageTogglePressed: { backgroundColor: colors.fill },
  lineageToggleText: {
    ...textStyles.subhead,
    fontWeight: '500',
    color: colors.textSecondary
  },
  chevronOpen: { transform: [{ rotate: '0deg' }] },
  chevronClosed: { transform: [{ rotate: '-90deg' }] }
})
