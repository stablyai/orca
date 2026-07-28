import { parseTeammateCommand } from '../../shared/claude-agent-teams-teammate-command'
import { paneEnv } from './claude-agent-teams-pane-layout'
import type { AgentTeam } from './claude-agent-teams-types'

export type TeammateLaunch = {
  command: string | undefined
  cwd: string | undefined
  env: Record<string, string>
}

// Why: Claude Code hands the shim a POSIX shell string (`cd <dir> && env K=V … <cmd>`) which
// only runs where the pane's shell is POSIX — PowerShell rejects `&&` and resolves `env` to
// nothing useful. Decompose it into Orca's own spawn options so no shell syntax is emitted
// and every pane shell behaves identically.
export function resolveTeammateLaunch(
  rawCommand: string,
  team: AgentTeam,
  fakePaneId: string
): TeammateLaunch {
  const env = paneEnv(team, fakePaneId)
  if (!rawCommand) {
    return { command: undefined, cwd: undefined, env }
  }
  const parsed = parseTeammateCommand(rawCommand)
  return {
    command: parsed.command || undefined,
    cwd: parsed.cwd,
    env: { ...env, ...parsed.env }
  }
}
