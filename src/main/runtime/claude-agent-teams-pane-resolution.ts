import type { AgentTeam, TeamPane } from './claude-agent-teams-types'

export type ResolvedTarget = { type: 'pane'; pane: TeamPane } | { type: 'window' }

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
