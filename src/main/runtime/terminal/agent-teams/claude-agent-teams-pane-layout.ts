import type { AgentTeam, AgentTeamsTerminalApi, TeamPane } from './claude-agent-teams-types'
import type { RuntimeTerminalSplit } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'

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
  // tmux -h means left/right; Orca names the vertical divider.
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

/** Starts a teammate under a handle the team holds before its process runs, so nothing can take
 *  it for a lone agent while the split starts; `adopt` records it before that hold ends. */
export async function splitTeammate<T>(
  team: AgentTeam,
  api: AgentTeamsTerminalApi,
  fromHandle: string,
  opts: { direction: 'horizontal' | 'vertical'; command?: string; fakePaneId: string },
  adopt: (split: RuntimeTerminalSplit) => T
): Promise<T> {
  const preAllocatedHandle = api.allocateTerminalHandle()
  team.startingHandles.add(preAllocatedHandle)
  try {
    const split = await api.splitTerminal(fromHandle, {
      direction: opts.direction,
      command: opts.command,
      env: paneEnv(team, opts.fakePaneId),
      envToDelete: ['TERM_PROGRAM'],
      activate: false,
      preAllocatedHandle
    })
    return adopt(split)
  } finally {
    team.startingHandles.delete(preAllocatedHandle)
  }
}
