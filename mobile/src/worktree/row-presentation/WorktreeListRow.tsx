import { memo } from 'react'
import { Bell, GitBranch } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import type { MobileRenderableRepoIcon } from '../../host-screen/host-screen-reply-schema'
import { triggerMediumImpact } from '../../platform/haptics/haptics'
import { colors, spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type {
  WorkspaceListItem,
  Worktree,
  WorktreeRowView
} from '../workspace-list/workspace-list-types'
import type { WorktreeCardDetails } from '../../../../src/shared/worktree/row-display/card-properties'
import { isRemoteExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { AgentActivityDisplayMode } from '../../../../src/shared/ui-chrome/ui-chrome-types'
import type { WorktreeStatus } from '../../../../src/shared/worktree/row-display/worktree-status-rollup'
import { areStructurallyEqual } from '../catalog/structural-equality'
import { projectGroupRowIndent } from '../project-sections/project-group-indent'
import { getWorktreeMetaGlyphPresence } from './worktree-meta-glyph-presence'
import { MobileBotHomeRow } from '../../bots/MobileBotHomeRow'
import { MobileBotWorkerLine } from '../../bots/MobileBotChatRows'
import { botWorkspaceLineAgent } from '../../../../src/shared/bots/bot-sidebar-workspaces'
import { structuredAgentSessionStatusPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-tab'
import { BotLineAgentLogos } from './BotLineAgentLogos'
import { agentDotState } from '../agent-lineage/agent-row-display'
import { useNow } from '../../hooks/use-now'
import {
  useWorktreeRowSession,
  workspaceCardActivation
} from '../../components/worktree-session-press'
import { WorktreeLineageToggle } from '../../components/worktree-lineage-toggle'
import { BotLineAgentMore } from './BotLineAgentMore'
import { AgentSpinner } from '../../agents/presentation/AgentSpinner'
import { HostContextPill } from './HostContextPill'
import { HostKindIcon } from '../../components/icons/HostKindIcon'
import { MobileRepoIcon } from '../../components/icons/MobileRepoIcon'
import { WorktreeAgentList } from '../agent-lineage/presentation/WorktreeAgentList'
import { WorktreeMetaGlyphs, prStateColor } from './WorktreeMetaGlyphs'
import { worktreeListRowStyles as styles } from './worktree-list-row-styles'
import { PrStateIcon } from '../../source-control/review/status/PrStateIcon'
import { WorktreeUnsavedName } from './WorktreeUnsavedName'

type Props = {
  item: Worktree
  view: WorktreeRowView
  isReadOnly: boolean
  repoColor: string
  repoIcon?: MobileRenderableRepoIcon | null
  // Grouped repo header already identifies project; omit duplicate icon/name on each row.
  hideRepo?: boolean
  /** What the desktop's shared Card layout and properties show, and where identity goes. */
  cardDetails: WorktreeCardDetails
  agentActivityDisplayMode: AgentActivityDisplayMode
  /** Null until a live read says (rows from the phone's store carry no agent state). */
  status: WorktreeStatus | null
  onPress: (item: Worktree) => void
  onAgentPress?: (item: Worktree, paneKey: string) => void
  /** Phone view setting: session rows are taller and open that session. */
  selectableSessions?: boolean
  statusLive?: boolean
  onLongPress?: (item: Worktree) => void
  /** Actions for one session. The card long-press stays the workspace menu. */
  onSessionLongPress?: (item: Worktree, paneKey: string) => void
  onToggleLineage?: (item: WorkspaceListItem) => void
  /** A bot row's "2 new": opens the bot's new threads. */
  /** A rename the desktop hasn't taken yet; the row keeps its real name and points to this one. */
  unsavedName?: string
  /** The paired computer, for a bot row's usage-limit stops. */
  pairedHostId?: string | null
}

function WorktreeListRowComponent({
  item,
  view,
  isReadOnly,
  repoColor,
  repoIcon,
  hideRepo = false,
  cardDetails,
  agentActivityDisplayMode,
  status: rowStatus,
  onPress,
  onAgentPress,
  selectableSessions = false,
  statusLive,
  onLongPress,
  onSessionLongPress,
  onToggleLineage,
  unsavedName,
  pairedHostId = null
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // Only a bot's worker line reads the clock here; other rows leave ticking to their agent list.
  const now = useNow(30_000, Boolean(view.botWorkspace))
  // A bot worker line shows its own agents' state.
  const status = view.botFacts?.status ?? rowStatus
  const isFolderWorkspace = item.workspaceKind === 'folder-workspace'
  const folderMeta =
    item.comment?.trim() || item.path || t('components.worktreeListRow.folder', 'Folder')
  const metaText =
    view.botFacts?.statusLine ??
    (isFolderWorkspace ? folderMeta : item.branch.replace(/^refs\/heads\//, ''))
  const lineageDepth = Math.max(0, view.lineageDepth ?? 0)
  const indent = projectGroupRowIndent(item, view) + lineageDepth * 18
  const count = view.lineageChildCount ?? 0
  const shouldHideRepo = hideRepo && !view.showProjectName
  const showRepoChip = cardDetails.repoInTitle && !shouldHideRepo && !isFolderWorkspace
  const showRepoInMetaRow = !cardDetails.repoInTitle && !shouldHideRepo
  const hostId = view.hostContextHostId ?? item.hostId
  const prState = item.linkedPR?.state ?? ''
  const prColor = prStateColor(prState)
  const hostAccessibilityLabel = [view.hostContextLabel, view.hostContextHealthLabel]
    .filter(Boolean)
    .join(', ')
  // Why: the desktop's compact card keeps an icon-only glyph for remote projects after the host badge goes.
  const showHostGlyph = !cardDetails.metaRow && isRemoteExecutionHostId(hostId)
  // A bot's worker line names its computer only when it isn't the bot's (the Bots list sets that).
  const showHostBadge = view.botWorkspace
    ? Boolean(view.hostContextLabel)
    : cardDetails.host && Boolean(view.hostContextLabel || view.hostContextHealthLabel)
  // A bot's worker line has no agent list, so one logo says who works there, as on the desktop.
  const lineAgent = view.botWorkspace
    ? botWorkspaceLineAgent(
        // Each host row is a pane of its own; provider subagents nest inside it, and parentPaneKey
        // is orchestration lineage (a bot's worker points at the bot's chat), not a subagent mark.
        // The state the row's agent list shows, so a stale "blocked" decays as it does there.
        (item.agents ?? []).map((agent) => ({
          agentType: agent.agentType,
          subagent: false,
          state: agentDotState(agent, now)
        }))
      )
    : null
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
  const sessionPress = useWorktreeRowSession(item, selectableSessions, onPress, onAgentPress)
  const handleLongPress = sessionPress.cardLongPress(onLongPress, triggerMediumImpact)
  const handleSessionLongPress = sessionPress.sessionLongPress(
    onSessionLongPress,
    triggerMediumImpact
  )

  if (view.botChatLine) {
    return (
      <MobileBotWorkerLine
        item={item}
        view={view}
        facts={view.botChatLine}
        status={status}
        isReadOnly={isReadOnly}
        onPress={onPress}
        onLongPress={onLongPress}
      />
    )
  }

  if (view.botFacts) {
    return (
      <MobileBotHomeRow
        item={item}
        view={view}
        isReadOnly={isReadOnly}
        pairedHostId={pairedHostId}
        // The bot opens on its Home Chat, which no row under it lists.
        onPress={() => {
          const chat = view.botFacts?.line.chatSessionId
          if (chat && onAgentPress) {
            onAgentPress(item, structuredAgentSessionStatusPaneKey(chat))
          } else {
            onPress(item)
          }
        }}
        onLongPress={openActions}
        onToggle={onToggleLineage ? () => onToggleLineage({ row: item, view }) : undefined}
      />
    )
  }

  return (
    <Pressable
      style={({ pressed }) => [
        styles.worktreeRow,
        indent > 0 && { paddingLeft: spacing.lg + indent },
        item.isActive && styles.worktreeRowActive,
        // The open session keeps this accent and takes the fill; the rest of the card does not.
        sessionPress.highlightedPane && { backgroundColor: colors.bgBase },
        view.dimmed && styles.worktreeRowDimmed,
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
            {lineAgent ? (
              <BotLineAgentLogos
                agent={lineAgent}
                ringColor={item.isActive ? colors.bgPanel : colors.bgBase}
              />
            ) : null}
            {lineAgent && lineAgent.others > 0 ? (
              <BotLineAgentMore others={lineAgent.others} needsYou={lineAgent.othersNeedYou} />
            ) : null}
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
            {/* A bot's worker line has no room for PR marks; the desktop drops them there too. */}
            {!view.botWorkspace && cardDetails.pr && item.linkedPR && (
              <View style={styles.prBadge}>
                <PrStateIcon state={prState} size={10} color={prColor} />
                <Text style={[styles.prNumber, { color: prColor }]}>#{item.linkedPR.number}</Text>
              </View>
            )}
            {isFolderWorkspace && !view.botFacts && (
              <View style={styles.folderBadge}>
                <Text style={styles.folderBadgeText}>
                  {t('components.worktreeListRow.folder', 'Folder')}
                </Text>
              </View>
            )}
            <WorktreeMetaGlyphs
              presence={{
                ...getWorktreeMetaGlyphPresence(item, cardDetails),
                ...(view.botWorkspace ? { gitLabMR: false } : {})
              }}
            />
            {item.liveTerminalCount > 0 ? (
              <Text style={styles.terminalCount}>{item.liveTerminalCount}</Text>
            ) : null}
          </View>
          {showMetaRow && (
            <View style={styles.worktreeMetaRow}>
              {lineageDepth > 0 && !view.botWorkspace && (
                <View style={styles.childBadge}>
                  <GitBranch size={10} color={colors.textMuted} />
                  <Text style={styles.childBadgeText}>
                    {t('components.worktreeListRow.child', 'Child')}
                  </Text>
                </View>
              )}
              {showHostBadge ? (
                <HostContextPill
                  hostId={hostId}
                  label={view.hostContextLabel}
                  healthLabel={view.hostContextHealthLabel}
                />
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
        </View>
        {unsavedName ? <WorktreeUnsavedName name={unsavedName} /> : null}
        {/* Match desktop agent activity only; plain terminal shell-output tails stay hidden. */}
        {!view.botWorkspace && cardDetails.inlineAgents && item.agents && item.agents.length > 0 ? (
          <WorktreeAgentList
            agents={item.agents}
            unvisited={item.unread}
            statusLive={statusLive}
            isReadOnly={isReadOnly}
            onAgentPress={sessionPress.openAgent}
            onAgentLongPress={openActions}
            fullList={agentActivityDisplayMode === 'full'}
            selectable={selectableSessions}
            selectedPaneKey={sessionPress.highlightedPane}
            onPressIn={sessionPress.claim}
            onPressOut={sessionPress.release}
            onWorkspacePress={sessionPress.openWorkspace}
            onLongPress={handleSessionLongPress}
          />
        ) : null}
        {count > 0 && onToggleLineage ? (
          <WorktreeLineageToggle
            item={{ row: item, view }}
            count={count}
            onToggle={onToggleLineage}
          />
        ) : null}
      </View>
    </Pressable>
  )
}

export const WorktreeListRow = memo(WorktreeListRowComponent, areStructurallyEqual)
