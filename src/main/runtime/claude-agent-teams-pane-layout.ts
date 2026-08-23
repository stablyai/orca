import type { AgentTeam, TeamPane } from './claude-agent-teams-types'

export type SplitTarget = { pane: TeamPane; direction: 'horizontal' | 'vertical' }
export type ResolvedTarget = { type: 'pane'; pane: TeamPane } | { type: 'window' }

export function requirePaneHandle(pane: TeamPane): string {
  if (!pane.handle) {
    throw new Error(`pane not started: ${pane.fakePaneId}`)
  }
  return pane.handle
}

export function resolveStartedPane(team: AgentTeam, pane: TeamPane): TeamPane {
  const visited = new Set<string>()
  let current = pane
  while (!current.handle) {
    if (visited.has(current.fakePaneId)) {
      throw new Error(`cyclic pane origin: ${current.fakePaneId}`)
    }
    visited.add(current.fakePaneId)
    current =
      (current.splitFromPane ? team.panes.get(current.splitFromPane) : undefined) ??
      resolvePane(team, team.leaderPane)
  }
  return current
}

export function resolvePane(team: AgentTeam, target: string): TeamPane {
  const pane = team.panes.get(target)
  if (!pane) {
    throw new Error(`unknown pane: ${target}`)
  }
  return pane
}

export function resolvePaneOrWindow(team: AgentTeam, target: string): ResolvedTarget {
  if (target.includes(':') || target === team.sessionName || target.startsWith('@')) {
    return { type: 'window' }
  }
  return { type: 'pane', pane: resolvePane(team, target) }
}

export function paneEnv(team: AgentTeam, fakePaneId: string): Record<string, string> {
  return {
    ...team.baseEnv,
    TMUX_PANE: fakePaneId,
    ORCA_AGENT_TEAMS_LEADER_PANE: team.leaderPane
  }
}

export function paneLaunchEnv(
  team: AgentTeam,
  fakePaneId: string,
  launchEnv: Record<string, string>
): Record<string, string> {
  return {
    ...paneEnv(team, fakePaneId),
    ...launchEnv,
    TMUX: team.tmuxValue,
    TMUX_PANE: fakePaneId,
    ORCA_AGENT_TEAMS_TEAM_ID: team.teamId,
    ORCA_AGENT_TEAMS_TOKEN: team.token
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
  return {
    pane: targetPane,
    direction: horizontal ? 'vertical' : 'horizontal'
  }
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

export function removePaneFromLayout(team: AgentTeam, pane: TeamPane): void {
  team.panes.delete(pane.fakePaneId)
  team.paneOrder = team.paneOrder.filter((id) => id !== pane.fakePaneId)
  if (team.mainVertical?.lastColumnPane === pane.fakePaneId) {
    team.mainVertical.lastColumnPane =
      [...team.paneOrder].toReversed().find((id) => id !== team.leaderPane) ?? null
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
