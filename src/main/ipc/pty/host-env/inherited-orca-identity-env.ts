// Who an Orca child is: its terminal, pane, chat session, launch, hook channel, bot, agent team, host
// stamp and remote target. Each child gets these from the Orca that starts it. A host process (the
// desktop app, Electron serve, orcad, the terminal daemon) is never such a child itself, so any copy it
// inherited names a terminal or agent of whichever Orca launched it, and a child holding it could pass
// as that owner terminal.
import {
  BOT_TOOLS_TOKEN_ENV,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
} from '../../../../shared/orchestration/orchestration-compatibility-evidence'
import { AGENT_PANE_HOOK_ENV_KEYS, ORCA_AGENT_SESSION_CALLER_ENV_KEYS } from './spawn-env-keys'

/** Which runtime the `orca` CLI targets; an inherited one points a child's CLI at another Orca. */
export const REMOTE_RUNTIME_SELECTOR_ENV_KEYS = [
  'ORCA_ENVIRONMENT',
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING'
] as const

/** Set on an agent-teams leader pane (claude-agent-teams-service.ts). */
export const AGENT_TEAMS_TEAM_ID_ENV = 'ORCA_AGENT_TEAMS_TEAM_ID'

export const INHERITED_ORCA_IDENTITY_ENV_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  ...AGENT_PANE_HOOK_ENV_KEYS,
  ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
  // A pane's workspace scope (terminal-workspace-scope.ts).
  'ORCA_WORKSPACE_ID',
  'ORCA_PROJECT_GROUP_ID',
  'ORCA_WORKSPACE_ROOT',
  BOT_TOOLS_TOKEN_ENV,
  ...REMOTE_RUNTIME_SELECTOR_ENV_KEYS,
  AGENT_TEAMS_TEAM_ID_ENV,
  'ORCA_AGENT_TEAMS_TOKEN',
  'ORCA_AGENT_TEAMS_LEADER_PANE',
  'ORCA_AGENT_TEAMS_SHIM_DIR',
  // A WSL pane's host stamp (wsl-orca-env.ts).
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV
] as const

/** Also a user's own override (claude-agent-teams-shim-env.ts), so dropped only beside a team's id. */
export const INHERITED_ORCA_TEAM_ENV_KEYS = ['ORCA_AGENT_TEAMS_SHIM_BIN'] as const

/** Run by each host process before it starts any child, so every spawn path starts from a clean env.
 *  The built Electron main runs the same drop from its banner (config/build-plugins). */
export function dropInheritedOrcaIdentityEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env[AGENT_TEAMS_TEAM_ID_ENV]) {
    for (const key of INHERITED_ORCA_TEAM_ENV_KEYS) {
      delete env[key]
    }
  }
  for (const key of INHERITED_ORCA_IDENTITY_ENV_KEYS) {
    delete env[key]
  }
}
