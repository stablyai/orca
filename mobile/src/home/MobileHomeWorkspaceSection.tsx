import { SquareTerminal } from 'lucide-react-native'
import { StyleSheet, View } from 'react-native'
import { MobileAgentIcon } from '../components/MobileAgentIcon'
import { useNow } from '../hooks/use-now'
import { ListGroup, LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { isTuiAgent } from '../../../src/shared/tui-agent-config'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import { colors } from '../theme/mobile-theme'
import type { HostCatalogEntry } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'
import { formatTimeAgo } from '../worktree/agent-row-display'
import type { HomeResumeCard } from '../worktree/home-resume-card'
import { homeWorktreeMainAgent, type HomeWorktreeSummary } from '../worktree/home-worktree-info'

function agentName(agentType: string | null | undefined): string | null {
  return isTuiAgent(agentType) ? MOBILE_TUI_AGENT_LABELS[agentType] : null
}

function rowTitle(worktree: HomeWorktreeSummary): string {
  return worktree.displayName || worktree.repo
}

/**
 * "Needs you" (`waiting`: agents asking for a permission or an answer, on connected desktops) or
 * "Jump back in" (the few workspaces touched last). Draws nothing when empty.
 */
export function MobileHomeWorkspaceSection(props: {
  waiting: boolean
  cards: readonly HomeResumeCard[]
  hosts: readonly HostCatalogEntry[]
  onOpen: (card: HomeResumeCard) => void
}) {
  // Only "Jump back in" shows "Done 12m ago", so only it ticks.
  const now = useNow(60_000, !props.waiting && props.cards.length > 0)
  if (props.cards.length === 0) {
    return null
  }
  return (
    <>
      <SectionHeader title={props.waiting ? 'Needs you' : 'Jump back in'} />
      <ListGroup separatorInset={LIST_LEADING_INSET}>
        {props.cards.map((card) => (
          <WorkspaceRow
            key={`${card.hostId}:${card.worktree.worktreeId}`}
            card={card}
            desktop={props.hosts.find((host) => host.id === card.hostId) ?? null}
            showDesktop={props.hosts.length > 1}
            waiting={props.waiting}
            now={now}
            onOpen={props.onOpen}
          />
        ))}
      </ListGroup>
    </>
  )
}

/** "Claude is working", "Done 12m ago", or null when the row has no agent news. */
function activityLabel(worktree: HomeWorktreeSummary, now: number): string | null {
  const agent = homeWorktreeMainAgent(worktree)
  const name = agentName(agent?.agentType)
  if (worktree.status === 'working') {
    return name ? `${name} is working` : 'Working'
  }
  if (worktree.status === 'done') {
    const doneAt = agent?.state === 'done' ? agent.stateStartedAt : worktree.lastOutputAt
    if (typeof doneAt !== 'number' || !Number.isFinite(doneAt)) {
      return 'Done'
    }
    const ago = formatTimeAgo(doneAt, now)
    return ago === 'just now' ? 'Done just now' : `Done ${ago} ago`
  }
  return null
}

function WorkspaceRow(props: {
  card: HomeResumeCard
  desktop: HostCatalogEntry | null
  showDesktop: boolean
  waiting: boolean
  now: number
  onOpen: (card: HomeResumeCard) => void
}) {
  const { worktree, actionable } = props.card
  const display = useHostDisplay(props.desktop)
  const desktopName = props.desktop ? display.title : 'your desktop'
  const title = rowTitle(worktree)
  const agent = homeWorktreeMainAgent(worktree)
  const name = agentName(agent?.agentType)
  const desktopPart = props.showDesktop ? desktopName : null
  let subtitle: string
  if (!actionable) {
    subtitle = `Connect ${desktopName} to resume.`
  } else if (props.waiting) {
    subtitle = [
      name ? `${name} is waiting for permission` : 'Waiting for your permission',
      desktopPart
    ]
      .filter(Boolean)
      .join(' · ')
  } else {
    const parts = [activityLabel(worktree, props.now), worktree.repo].filter(
      (part): part is string => Boolean(part) && part !== title
    )
    subtitle = [...(parts.length > 0 ? parts : [worktree.branch]), desktopPart]
      .filter(Boolean)
      .join(' · ')
  }
  const leading = agent?.agentType ? (
    <MobileAgentIcon agentId={agent.agentType} size={20} />
  ) : props.waiting ? (
    <View style={styles.waitingDot} />
  ) : (
    <SquareTerminal size={20} color={colors.textSecondary} strokeWidth={2} />
  )
  return (
    <ListRow
      title={title}
      subtitle={subtitle}
      subtitleColor={props.waiting && actionable ? colors.statusAmber : undefined}
      leading={leading}
      navigates
      disabled={!actionable}
      onPress={() => props.onOpen(props.card)}
      accessibilityLabel={`${title}, ${subtitle}`}
    />
  )
}

const styles = StyleSheet.create({
  waitingDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.statusAmber }
})
