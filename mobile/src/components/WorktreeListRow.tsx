import { memo } from 'react'
import { Bell, ChevronDown, ChevronRight, GitBranch, GitPullRequest } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { triggerMediumImpact } from '../platform/haptics'
import { colors, spacing } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { WorkspaceListItem, Worktree, WorktreeRowView } from '../worktree/workspace-list-types'
import type { WorktreeCardDetails } from '../../../src/shared/worktree/card-properties'
import { isRemoteExecutionHostId } from '../../../src/shared/execution-host'
import {
  DEFAULT_SHOW_SUBAGENTS,
  DEFAULT_SUBAGENT_DISPLAY_MODE
} from '../../../src/shared/constants'
import type {
  AgentActivityDisplayMode,
  SubagentDisplayMode
} from '../../../src/shared/ui-chrome-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { areStructurallyEqual } from '../worktree/structural-equality'
import { projectGroupRowIndent } from '../worktree/project-group-indent'
import { getWorktreeMetaGlyphPresence } from '../worktree/worktree-meta-glyph-presence'
import { AgentSpinner } from './AgentSpinner'
import { HostKindIcon } from './HostKindIcon'
import { MobileRepoIcon } from './MobileRepoIcon'
import { WorktreeAgentList } from './WorktreeAgentList'
import { WorktreeMetaGlyphs, prStateColor } from './WorktreeMetaGlyphs'
import { worktreeListRowStyles as styles } from './worktree-list-row-styles'

// Match desktop formatBranchName by hiding refs/heads/ prefix.
function displayBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

type Props = {
  item: Worktree
  view: WorktreeRowView
  isReadOnly: boolean
  now: number
  repoColor: string
  repoIcon?: MobileRenderableRepoIcon | null
  // Grouped repo header already identifies project; omit duplicate icon/name on each row.
  hideRepo?: boolean
  /** What the desktop's shared Card layout and properties show, and where identity goes. */
  cardDetails: WorktreeCardDetails
  agentActivityDisplayMode: AgentActivityDisplayMode
  showSubagents?: boolean
  subagentDisplayMode?: SubagentDisplayMode
  status: WorktreeStatus
  onPress: (item: Worktree) => void
  onAgentPress?: (item: Worktree, paneKey: string) => void
  statusLive?: boolean
  onLongPress?: (item: Worktree) => void
  onToggleLineage?: (item: WorkspaceListItem) => void
}

function WorktreeListRowComponent({
  item,
  view,
  isReadOnly,
  now,
  repoColor,
  repoIcon,
  hideRepo = false,
  cardDetails,
  agentActivityDisplayMode,
  showSubagents = DEFAULT_SHOW_SUBAGENTS,
  subagentDisplayMode = DEFAULT_SUBAGENT_DISPLAY_MODE,
  status,
  onPress,
  onAgentPress,
  statusLive,
  onLongPress,
  onToggleLineage
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const isFolderWorkspace = item.workspaceKind === 'folder-workspace'
  const isFloatingWorkspace = item.workspaceKind === 'floating'
  const folderMeta =
    item.comment?.trim() || item.path || t('components.worktreeListRow.folder', 'Folder')
  const floatingMeta = item.path || t('components.worktreeListRow.floating', 'Floating terminal')
  const metaText = isFloatingWorkspace
    ? floatingMeta
    : isFolderWorkspace
      ? folderMeta
      : displayBranch(item.branch)
  const lineageDepth = Math.max(0, view.lineageDepth ?? 0)
  const indent = projectGroupRowIndent(item, view) + lineageDepth * 18
  const count = view.lineageChildCount ?? 0
  const shouldHideRepo = hideRepo && !view.showProjectName
  const showRepoChip =
    cardDetails.repoInTitle && !shouldHideRepo && !isFolderWorkspace && !isFloatingWorkspace
  const showRepoInMetaRow = !cardDetails.repoInTitle && !shouldHideRepo && !isFloatingWorkspace
  const hostId = view.hostContextHostId ?? item.hostId
  const hostAccessibilityLabel = [view.hostContextLabel, view.hostContextHealthLabel]
    .filter(Boolean)
    .join(', ')
  // Why: the desktop's compact card keeps an icon-only glyph for remote projects after the host badge goes.
  const showHostGlyph = !cardDetails.metaRow && isRemoteExecutionHostId(hostId)
  const showHostBadge =
    cardDetails.host && Boolean(view.hostContextLabel || view.hostContextHealthLabel)
  // Why: like the desktop, skip a blank meta lane when every part of it is off.
  const showMetaRow =
    cardDetails.metaRow &&
    (lineageDepth > 0 || showHostBadge || showRepoInMetaRow || cardDetails.identity)
  // Agent rows take their own taps, so they share the card's long-press menu.
  const openActions = onLongPress
    ? () => {
        triggerMediumImpact()
        onLongPress(item)
      }
    : undefined

  return (
    <Pressable
      style={({ pressed }) => [
        styles.worktreeRow,
        indent > 0 && { paddingLeft: spacing.lg + indent },
        item.isActive && styles.worktreeRowActive,
        pressed && (item.isActive ? styles.worktreeRowActivePressed : styles.worktreeRowPressed)
      ]}
      disabled={isReadOnly}
      onPress={() => onPress(item)}
      onLongPress={openActions}
      delayLongPress={400}
    >
      <View style={styles.indicatorCol}>
        <AgentSpinner status={status} workingMode={item.workingMode} />
        {item.unread && (
          <Bell
            size={10}
            color={colors.statusAmber}
            fill={colors.statusAmber}
            style={styles.unreadBell}
          />
        )}
      </View>

      <View style={styles.worktreeMain}>
        <View style={styles.worktreeNameRow}>
          {showHostGlyph && (
            <View
              accessibilityLabel={
                hostAccessibilityLabel || t('components.worktreeListRow.remoteHost', 'Remote host')
              }
            >
              <HostKindIcon hostId={hostId} size={11} />
            </View>
          )}
          {showRepoChip && (
            <View
              style={styles.repoChip}
              accessibilityLabel={t('components.worktreeListRow.project', 'Project {{repo}}', {
                repo: item.repo
              })}
            >
              <MobileRepoIcon repoIcon={repoIcon} size={11} color={repoColor} />
            </View>
          )}
          <Text
            style={[
              styles.worktreeName,
              item.unread && styles.worktreeNameUnread,
              isReadOnly && styles.textReadOnly
            ]}
            numberOfLines={1}
          >
            {item.displayName || item.repo}
          </Text>
          {cardDetails.pr && item.linkedPR && (
            <View style={styles.prBadge}>
              <GitPullRequest size={10} color={prStateColor(item.linkedPR.state)} />
              <Text style={[styles.prNumber, { color: prStateColor(item.linkedPR.state) }]}>
                #{item.linkedPR.number}
              </Text>
            </View>
          )}
          {isFolderWorkspace && (
            <View style={styles.folderBadge}>
              <Text style={styles.folderBadgeText}>
                {t('components.worktreeListRow.folder', 'Folder')}
              </Text>
            </View>
          )}
          <WorktreeMetaGlyphs presence={getWorktreeMetaGlyphPresence(item, cardDetails)} />
          {item.liveTerminalCount > 0 ? (
            <Text style={styles.terminalCount}>{item.liveTerminalCount}</Text>
          ) : null}
        </View>
        {showMetaRow && (
          <View style={styles.worktreeMetaRow}>
            {lineageDepth > 0 && (
              <View style={styles.childBadge}>
                <GitBranch size={10} color={colors.textMuted} />
                <Text style={styles.childBadgeText}>
                  {t('components.worktreeListRow.child', 'Child')}
                </Text>
              </View>
            )}
            {showHostBadge ? (
              <View
                style={[styles.childBadge, styles.hostBadge]}
                accessibilityLabel={hostAccessibilityLabel}
              >
                <HostKindIcon hostId={hostId} size={10} />
                {view.hostContextLabel ? (
                  <Text style={[styles.childBadgeText, styles.hostBadgeText]} numberOfLines={1}>
                    {view.hostContextLabel}
                  </Text>
                ) : null}
                {/* Why separate Text: the name truncates first so the health word stays readable. */}
                {view.hostContextHealthLabel ? (
                  <Text style={[styles.childBadgeText, styles.hostHealthText]}>
                    {view.hostContextLabel
                      ? `· ${view.hostContextHealthLabel}`
                      : view.hostContextHealthLabel}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {/* Show repo identity only outside grouping/title-chip cases; Folder fallback matches desktop. */}
            {showRepoInMetaRow && (
              <>
                <MobileRepoIcon repoIcon={repoIcon} size={11} color={repoColor} />
                <Text style={styles.repoName} numberOfLines={1}>
                  {item.repo}
                </Text>
              </>
            )}
            {cardDetails.identity && (
              <Text style={styles.branchName} numberOfLines={1}>
                {metaText}
              </Text>
            )}
          </View>
        )}
        {/* Match desktop agent activity only; plain terminal shell-output tails stay hidden. */}
        {cardDetails.inlineAgents && item.agents && item.agents.length > 0 ? (
          <WorktreeAgentList
            agents={item.agents}
            now={now}
            unvisited={item.unread}
            statusLive={statusLive}
            isReadOnly={isReadOnly}
            onAgentPress={onAgentPress ? (paneKey) => onAgentPress(item, paneKey) : undefined}
            onAgentLongPress={openActions}
            fullList={agentActivityDisplayMode === 'full'}
            showSubagents={showSubagents}
            subagentDisplayMode={subagentDisplayMode}
          />
        ) : null}
        {count > 0 && onToggleLineage ? (
          <Pressable
            style={({ pressed }) => [styles.lineageToggle, pressed && styles.lineageTogglePressed]}
            hitSlop={LINEAGE_TOGGLE_HIT_SLOP}
            onPress={(event) => {
              event.stopPropagation()
              onToggleLineage({ row: item, view })
            }}
          >
            {view.lineageCollapsed ? (
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
        ) : null}
      </View>
    </Pressable>
  )
}

export const WorktreeListRow = memo(WorktreeListRowComponent, areStructurallyEqual)

// Grows the 20 pt pill to a 44 pt target without pushing the row apart.
const LINEAGE_TOGGLE_HIT_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const
