import { memo } from 'react'
import { Bell, GitBranch, GitPullRequest } from 'lucide-react-native'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../host-screen/host-screen-reply-schema'
import { triggerMediumImpact } from '../platform/haptics'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { Worktree } from '../worktree/workspace-list-types'
import type { WorktreeCardDetails } from '../../../src/shared/worktree/card-properties'
import { isRemoteExecutionHostId } from '../../../src/shared/execution-host'
import type { AgentActivityDisplayMode } from '../../../src/shared/ui-chrome-types'
import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import { areStructurallyEqual } from '../worktree/structural-equality'
import { projectGroupRowIndent } from '../worktree/project-group-indent'
import { getWorktreeMetaGlyphPresence } from '../worktree/worktree-meta-glyph-presence'
import { AgentSpinner } from './AgentSpinner'
import { HostKindIcon } from './HostKindIcon'
import { MobileRepoIcon } from './MobileRepoIcon'
import { WorktreeAgentList } from './WorktreeAgentList'
import { WorktreeLineageToggle } from './worktree-lineage-toggle'
import { WorktreeMetaGlyphs, prStateColor } from './WorktreeMetaGlyphs'
import { displayBranch, WORKTREE_ROW_LAYOUT } from './worktree-list-row-layout'
import { useWorktreeRowSession, workspaceCardActivation } from './worktree-session-press'

type Props = {
  item: Worktree
  isReadOnly: boolean
  now: number
  repoColor: string
  repoIcon?: MobileRenderableRepoIcon | null
  // Grouped repo header already identifies project; omit duplicate icon/name on each row.
  hideRepo?: boolean
  /** What the desktop's shared Card layout and properties show, and where identity goes. */
  cardDetails: WorktreeCardDetails
  agentActivityDisplayMode: AgentActivityDisplayMode
  status: WorktreeStatus
  onPress: (item: Worktree) => void
  onAgentPress?: (item: Worktree, paneKey: string) => void
  /** Phone view setting: session rows are taller and open that session. */
  selectableSessions?: boolean
  statusLive?: boolean
  onLongPress?: (item: Worktree) => void
  /** Actions for one session. The card long-press stays the workspace menu. */
  onSessionLongPress?: (item: Worktree, paneKey: string) => void
  onToggleLineage?: (item: Worktree) => void
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
  selectableSessions = false,
  statusLive,
  onLongPress,
  onSessionLongPress,
  onToggleLineage
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const isFolderWorkspace = item.workspaceKind === 'folder-workspace'
  const folderMeta =
    item.comment?.trim() || item.path || t('components.worktreeListRow.folder', 'Folder')
  const metaText = isFolderWorkspace ? folderMeta : displayBranch(item.branch)
  const lineageDepth = Math.max(0, item.lineageDepth ?? 0)
  const indent = projectGroupRowIndent(item) + lineageDepth * 18
  const count = item.lineageChildCount ?? 0
  const shouldHideRepo = hideRepo && !item.showProjectName
  const showRepoChip = cardDetails.repoInTitle && !shouldHideRepo && !isFolderWorkspace
  const showRepoInMetaRow = !cardDetails.repoInTitle && !shouldHideRepo
  const hostId = item.hostContextHostId ?? item.hostId
  const hostAccessibilityLabel = [item.hostContextLabel, item.hostContextHealthLabel]
    .filter(Boolean)
    .join(', ')
  // Why: the desktop's compact card keeps an icon-only glyph for remote projects after the host badge goes.
  const showHostGlyph = !cardDetails.metaRow && isRemoteExecutionHostId(hostId)
  const sessionPress = useWorktreeRowSession(item, selectableSessions, onPress, onAgentPress)
  const handleLongPress = sessionPress.cardLongPress(onLongPress, triggerMediumImpact)
  const handleSessionLongPress = sessionPress.sessionLongPress(
    onSessionLongPress,
    triggerMediumImpact
  )

  return (
    <Pressable
      style={({ pressed }) => [
        styles.worktreeRow,
        indent > 0 && { paddingLeft: spacing.lg + indent },
        item.isActive && styles.worktreeRowActive,
        // The open session keeps this accent and takes the fill; the rest of the card does not.
        sessionPress.highlightedPane && { backgroundColor: colors.bgBase },
        pressed &&
          !sessionPress.isClaimed() &&
          (item.isActive ? styles.worktreeRowActivePressed : styles.worktreeRowPressed)
      ]}
      // One press target. An accessible card would hide the session rows from VoiceOver.
      accessible={false}
      disabled={isReadOnly}
      onPress={sessionPress.press}
      onLongPress={handleLongPress}
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
        <View {...workspaceCardActivation(isReadOnly, sessionPress.press)}>
          <View style={styles.worktreeNameRow}>
            {showHostGlyph && (
              <View
                accessibilityLabel={
                  hostAccessibilityLabel ||
                  t('components.worktreeListRow.remoteHost', 'Remote host')
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
          {cardDetails.metaRow && (
            <View style={styles.worktreeMetaRow}>
              {lineageDepth > 0 && (
                <View style={styles.childBadge}>
                  <GitBranch size={10} color={colors.textMuted} />
                  <Text style={styles.childBadgeText}>
                    {t('components.worktreeListRow.child', 'Child')}
                  </Text>
                </View>
              )}
              {cardDetails.host && (item.hostContextLabel || item.hostContextHealthLabel) ? (
                <View
                  style={[styles.childBadge, styles.hostBadge]}
                  accessibilityLabel={hostAccessibilityLabel}
                >
                  <HostKindIcon hostId={hostId} size={10} />
                  {item.hostContextLabel ? (
                    <Text style={[styles.childBadgeText, styles.hostBadgeText]} numberOfLines={1}>
                      {item.hostContextLabel}
                    </Text>
                  ) : null}
                  {/* Why separate Text: the name truncates first so the health word stays readable. */}
                  {item.hostContextHealthLabel ? (
                    <Text style={[styles.childBadgeText, styles.hostHealthText]}>
                      {item.hostContextLabel
                        ? `· ${item.hostContextHealthLabel}`
                        : item.hostContextHealthLabel}
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
              <Text style={styles.branchName} numberOfLines={1}>
                {metaText}
              </Text>
            </View>
          )}
        </View>
        {/* Match desktop agent activity only; plain terminal shell-output tails stay hidden. */}
        {cardDetails.inlineAgents && item.agents && item.agents.length > 0 ? (
          <WorktreeAgentList
            agents={item.agents}
            now={now}
            unvisited={item.unread}
            statusLive={statusLive}
            isReadOnly={isReadOnly}
            onAgentPress={sessionPress.openAgent}
            selectedPaneKey={sessionPress.highlightedPane}
            fullList={agentActivityDisplayMode === 'full'}
            selectable={selectableSessions}
            onPressIn={sessionPress.claim}
            onPressOut={sessionPress.release}
            onWorkspacePress={sessionPress.openWorkspace}
            onLongPress={handleSessionLongPress}
          />
        ) : null}
        {count > 0 && onToggleLineage ? (
          <WorktreeLineageToggle item={item} count={count} onToggle={onToggleLineage} />
        ) : null}
      </View>
    </Pressable>
  )
}

export const WorktreeListRow = memo(WorktreeListRowComponent, areStructurallyEqual)

const styles = themedStyleSheet(() => ({
  worktreeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingVertical: spacing.md,
    paddingLeft: spacing.lg,
    paddingRight: spacing.lg,
    // Reserve the active accent bar width so active/inactive rows align.
    borderLeftWidth: WORKTREE_ROW_LAYOUT.accentWidth,
    borderLeftColor: 'transparent'
  },
  worktreeRowPressed: {
    backgroundColor: colors.bgRaised
  },
  // The active row already wears bgPanel, so its press needs a wash that reads over it.
  worktreeRowActivePressed: {
    backgroundColor: colors.translucentFill
  },
  // Match desktop focused-worktree card with raised fill and left accent.
  worktreeRowActive: {
    backgroundColor: colors.bgPanel,
    // Use desktop active-tab neutral accent, not blue.
    borderLeftColor: colors.textSecondary
  },
  indicatorCol: {
    width: WORKTREE_ROW_LAYOUT.indicatorWidth,
    alignItems: 'center',
    paddingTop: 6,
    marginRight: spacing.sm,
    gap: 4
  },
  unreadBell: {
    marginTop: 2
  },
  worktreeMain: {
    flex: 1
  },
  worktreeNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
  worktreeName: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    flexShrink: 1
  },
  worktreeNameUnread: {
    fontWeight: '700'
  },
  textReadOnly: {
    opacity: 0.5
  },
  prBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  prNumber: {
    fontSize: 10,
    color: colors.textSecondary
  },
  // Why: matches the desktop's compact repo chip, a small framed icon ahead of the title.
  repoChip: {
    width: 16,
    height: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.mark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    backgroundColor: colors.bgRaised
  },
  folderBadge: {
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  folderBadgeText: {
    fontSize: 10,
    color: colors.textSecondary
  },
  worktreeMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
    gap: spacing.xs
  },
  repoName: {
    fontSize: 11,
    color: colors.textSecondary,
    maxWidth: 100
  },
  branchName: {
    fontSize: 11,
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    // Why: path takes only leftover space so badges truncate last.
    flex: 1
  },
  childBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.bgRaised,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: radii.pill
  },
  childBadgeText: {
    fontSize: 10,
    color: colors.textMuted
  },
  // Why the cap is on the name, not the badge: a health word after a long name must stay readable.
  hostBadge: {
    flexShrink: 1
  },
  hostBadgeText: {
    flexShrink: 1,
    maxWidth: 100
  },
  hostHealthText: {
    flexShrink: 0
  },
  terminalCount: {
    marginLeft: 'auto',
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
}))
