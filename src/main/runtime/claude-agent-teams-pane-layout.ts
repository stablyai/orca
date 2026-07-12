import type { AgentTeam, TeamPane } from './claude-agent-teams-types'

export type SplitTarget = { pane: TeamPane; direction: 'horizontal' | 'vertical' }

export function paneEnv(team: AgentTeam, fakePaneId: string): Record<string, string> {
  return {
    ...team.baseEnv,
    TMUX_PANE: fakePaneId,
    ORCA_AGENT_TEAMS_LEADER_PANE: team.leaderPane
  }
}

export function resolveSplitTarget(
  team: AgentTeam,
  targetPane: TeamPane,
  horizontal: boolean
): SplitTarget {
  if (horizontal && team.mainVertical?.lastColumnPane) {
    return {
      pane: team.panes.get(team.mainVertical.lastColumnPane) ?? targetPane,
      direction: 'horizontal'
    }
  }
  // Why: tmux `split-window -h` means left/right panes; Orca names that
  // layout by the vertical divider it creates.
  return { pane: targetPane, direction: horizontal ? 'vertical' : 'horizontal' }
}

export function updateMainVerticalAfterSplit(
  team: AgentTeam,
  fakePaneId: string,
  splitTarget: SplitTarget
): void {
  if (team.mainVertical) {
    team.mainVertical.lastColumnPane = fakePaneId
  } else if (
    splitTarget.direction === 'vertical' &&
    splitTarget.pane.fakePaneId === team.leaderPane
  ) {
    team.mainVertical = { mainPane: team.leaderPane, lastColumnPane: fakePaneId }
  }
}

export function formatContext(team: AgentTeam, pane: TeamPane): Record<string, string> {
  return {
    session_name: team.sessionName,
    session_id: '$0',
    window_id: '@0',
    window_index: team.windowIndex,
    window_name: 'agent-teams',
    window_active: '1',
    window_flags: '*',
    pane_id: pane.fakePaneId,
    pane_index: String(pane.index),
    pane_active: pane.fakePaneId === team.leaderPane ? '1' : '0',
    pane_title: '',
    pane_width: '',
    pane_height: '',
    pane_left: '',
    pane_top: '',
    window_width: '',
    window_height: ''
  }
}
