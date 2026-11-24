import { memo } from 'react'
import { ChevronDown, ChevronRight, GitMerge } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { triggerMediumImpact } from '../../platform/haptics/haptics'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type {
  WorkspaceListItem,
  Worktree,
  WorktreeRowView
} from '../workspace-list/workspace-list-types'
import { isRemoteExecutionHostId } from '../../../../src/shared/execution-host/execution-host'
import type { WorktreeStatus } from '../../../../src/shared/worktree/row-display/worktree-status-rollup'
import { AGENT_LIST_STATUS_RANK } from '../../../../src/shared/agent-status/presentation/agent-list-status'
import type { RuntimeWorktreeAgentRow } from '../../../../src/shared/worktree/catalog/runtime-worktree-contracts'
import { areStructurallyEqual } from '../catalog/structural-equality'
import { projectGroupRowIndent } from '../project-sections/project-group-indent'
import { MobileBotHomeRow } from '../../bots/MobileBotHomeRow'
import { MobileBotWorkerLine } from '../../bots/MobileBotChatRows'
import { botWorkspaceLineAgent } from '../../../../src/shared/bots/bot-sidebar-workspaces'
import { structuredAgentSessionStatusPaneKey } from '../../../../src/shared/agent-session/view/structured-agent-session-tab'
import { BotLineAgentLogos } from './BotLineAgentLogos'
import { agentDotState, agentRowTimeAt, formatTimeAgo } from '../agent-lineage/agent-row-display'
import { useSharedNow } from '../../hooks/use-now'
import { AgentSpinner } from '../../agents/presentation/AgentSpinner'
import { HostContextPill } from './HostContextPill'
import { HostKindIcon } from '../../components/icons/HostKindIcon'
import { MobileRepoIcon } from '../../components/icons/MobileRepoIcon'
import type { RepoLook } from '../../host-screen/catalog/host-repo-looks'
import { prStateColor } from './pr-state-color'
import { worktreeListRowStyles as styles } from './worktree-list-row-styles'
import { WORKTREE_ROW_LAYOUT } from './worktree-list-row-layout'
import { PrStateIcon } from '../../source-control/review/status/PrStateIcon'
import { WorktreeUnsavedName } from './WorktreeUnsavedName'

type Props = {
  item: Worktree
  view: WorktreeRowView
  isReadOnly: boolean
  /** Null until a live read says (rows from the phone's store carry no agent state). */
  status: WorktreeStatus | null
  onPress: (item: Worktree) => void
  onAgentPress?: (item: Worktree, paneKey: string) => void
  onLongPress?: (item: Worktree) => void
  onToggleLineage?: (item: WorkspaceListItem) => void
  /** A rename the desktop hasn't taken yet; the row keeps its real name and points to this one. */
  unsavedName?: string
  /** The paired computer, for a bot row's usage-limit stops. */
  pairedHostId?: string | null
  /** Its project's icon, where no project heading above the row names it. */
  repoLook?: RepoLook | null
  /** The tablet sidebar marks the workspace its detail pane shows. */
  showSelection?: boolean
}

const NEEDS_YOU_RANK = AGENT_LIST_STATUS_RANK.permission

function needsYou(agent: RuntimeWorktreeAgentRow, now: number): boolean {
  return AGENT_LIST_STATUS_RANK[agentDotState(agent, now)] <= NEEDS_YOU_RANK
}

function WorktreeListRowComponent({
  item,
  view,
  isReadOnly,
  status: rowStatus,
  onPress,
  onAgentPress,
  onLongPress,
  onToggleLineage,
  unsavedName,
  pairedHostId = null,
  repoLook = null,
  showSelection = false
}: Props) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  // A bot worker line shows its own agents' state.
  const status = view.botFacts?.status ?? rowStatus
  const lineageDepth = Math.max(0, view.lineageDepth ?? 0)
  const indent = projectGroupRowIndent(item, view) + lineageDepth * 18
  const count = view.lineageChildCount ?? 0
  const hostId = view.hostContextHostId ?? item.hostId
  const agents = item.agents ?? []
  const openActions = onLongPress
    ? () => {
        triggerMediumImpact()
        onLongPress(item)
      }
    : undefined

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

  // A row that needs you opens on the agent asking, which its trailing word names.
  const open = () => {
    const asking = onAgentPress ? agents.find((agent) => needsYou(agent, Date.now())) : undefined
    if (asking && onAgentPress) {
      onAgentPress(item, asking.paneKey)
    } else {
      onPress(item)
    }
  }
  const name = item.displayName || item.repo

  return (
    <Pressable
      style={({ pressed }) => [
        styles.worktreeRow,
        indent > 0 && { paddingLeft: WORKTREE_ROW_LAYOUT.indicatorInset + indent },
        showSelection && item.isActive && styles.worktreeRowSelected,
        view.dimmed && styles.worktreeRowDimmed,
        pressed && styles.worktreeRowPressed
      ]}
      disabled={isReadOnly}
      onPress={open}
      onLongPress={openActions}
      delayLongPress={400}
      accessibilityRole="button"
      accessibilityState={{ disabled: isReadOnly }}
    >
      <View style={styles.indicatorCol}>
        <AgentSpinner status={status} workingMode={item.workingMode} />
      </View>
      <View style={styles.worktreeMain}>
        <View style={styles.worktreeNameRow}>
          {view.botWorkspace ? <BotWorkspaceLogos item={item} /> : null}
          {isRemoteExecutionHostId(hostId) && !view.botWorkspace ? (
            <HostKindIcon hostId={hostId} size={12} />
          ) : null}
          {repoLook ? (
            <View accessibilityLabel={item.repo}>
              <MobileRepoIcon repoIcon={repoLook.icon} size={14} color={repoLook.color} />
            </View>
          ) : null}
          <Text
            style={[
              styles.worktreeName,
              item.isMainWorktree === true && styles.worktreeNameMain,
              item.unread && styles.worktreeNameUnread,
              isReadOnly && styles.textReadOnly
            ]}
            numberOfLines={1}
          >
            {name}
          </Text>
        </View>
        {unsavedName ? <WorktreeUnsavedName name={unsavedName} /> : null}
      </View>
      <View style={styles.trailing}>
        {view.botWorkspace && view.hostContextLabel ? (
          <HostContextPill
            hostId={hostId}
            label={view.hostContextLabel}
            healthLabel={view.hostContextHealthLabel}
          />
        ) : null}
        {view.botWorkspace ? null : agents.length > 0 ? (
          <WorktreeAgentFacts item={item} agents={agents} />
        ) : (
          <PrMark item={item} />
        )}
        {count > 0 && onToggleLineage ? (
          <Pressable
            style={styles.lineageToggle}
            hitSlop={LINEAGE_TOGGLE_HIT_SLOP}
            accessibilityRole="button"
            accessibilityState={{ expanded: !view.lineageCollapsed }}
            accessibilityLabel={
              count === 1
                ? t('components.worktreeListRow.children_one', '{{count}} child', { count })
                : t('components.worktreeListRow.children_other', '{{count}} children', { count })
            }
            onPress={(event) => {
              event.stopPropagation()
              onToggleLineage({ row: item, view })
            }}
          >
            <Text style={styles.lineageCount}>{count}</Text>
            {view.lineageCollapsed ? (
              <ChevronRight size={16} color={colors.textMuted} />
            ) : (
              <ChevronDown size={16} color={colors.textMuted} />
            )}
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  )
}

export const WorktreeListRow = memo(WorktreeListRowComponent, areStructurallyEqual)

// A bot worker's line names who works there by logo, as on the desktop.
function BotWorkspaceLogos({ item }: { item: Worktree }) {
  const now = useSharedNow(30_000)
  const lineAgent = botWorkspaceLineAgent(
    // Each host row is a pane of its own; parentPaneKey is orchestration lineage, not a subagent mark.
    (item.agents ?? []).map((agent) => ({
      agentType: agent.agentType,
      subagent: false,
      state: agentDotState(agent, now)
    }))
  )
  return lineAgent ? <BotLineAgentLogos agent={lineAgent} ringColor={colors.bgPanel} /> : null
}

/** A workspace's agents at its right edge: who needs you, else its PR and when they last changed. */
function WorktreeAgentFacts({
  item,
  agents
}: {
  item: Worktree
  agents: readonly RuntimeWorktreeAgentRow[]
}) {
  const t = useMobileTranslation()
  const now = useSharedNow(30_000)
  const asking = agents.filter((agent) => needsYou(agent, now))
  if (asking.length > 0) {
    return (
      <>
        <AgentLogos agents={asking} now={now} />
        <Text style={[styles.stateWord, { color: colors.agentQuestionText }]}>
          {t('components.worktreeListRow.needsYou', 'Needs you')}
        </Text>
      </>
    )
  }
  const failed = agents.some((agent) => agentDotState(agent, now) === 'failed')
  const latest = Math.max(...agents.map(agentRowTimeAt))
  return (
    <>
      <PrMark item={item} />
      <AgentLogos agents={agents} now={now} />
      {failed ? (
        <Text style={[styles.stateWord, { color: colors.statusRed }]}>
          {t('worktree.agentRowDisplay.failed', 'Failed')}
        </Text>
      ) : latest > 0 ? (
        <Text style={styles.time}>{formatTimeAgo(latest, now)}</Text>
      ) : null}
    </>
  )
}

// A GitHub PR in its state's colour, else a GitLab MR, whose row carries only its number.
function PrMark({ item }: { item: Worktree }) {
  const pr = item.linkedPR
  if (pr) {
    const color = prStateColor(pr.state)
    return (
      <View style={styles.prMark}>
        <PrStateIcon state={pr.state} size={12} color={color} strokeWidth={2.4} />
        <Text style={[styles.prNumber, { color }]}>{pr.number}</Text>
      </View>
    )
  }
  const mr = item.linkedGitLabMR
  return mr ? (
    <View style={styles.prMark}>
      <GitMerge size={12} color={colors.textMuted} strokeWidth={2.4} />
      <Text style={[styles.prNumber, { color: colors.textMuted }]}>{mr}</Text>
    </View>
  ) : null
}

function AgentLogos({ agents, now }: { agents: readonly RuntimeWorktreeAgentRow[]; now: number }) {
  const lineAgent = botWorkspaceLineAgent(
    agents.map((agent) => ({
      agentType: agent.agentType,
      subagent: false,
      state: agentDotState(agent, now)
    }))
  )
  return lineAgent ? <BotLineAgentLogos agent={lineAgent} ringColor={colors.bgPanel} /> : null
}

// Grows the 16 pt chevron to a 44 pt target without pushing the row apart.
const LINEAGE_TOGGLE_HIT_SLOP = { top: 14, bottom: 14, left: 8, right: 14 } as const
