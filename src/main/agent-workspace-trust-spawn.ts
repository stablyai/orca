import { TUI_AGENT_CONFIG, isTuiAgent } from '../shared/tui-agent-config'
import type { GlobalSettings } from '../shared/global-settings-types'
import { resolveTerminalWorkspacePath } from '../shared/terminal-startup-cwd'
import {
  applyAgentWorkspaceTrust,
  type AgentTrustLaunchContext,
  type AgentTrustSpawnFields
} from './agent-workspace-trust'
import { AGENT_TRUST_KEYED_BY_START_FOLDER } from './execution-host-workspace-trust'

type AgentWorkspaceTrustSetting =
  | Partial<Pick<GlobalSettings, 'agentWorkspaceTrustEnabled'>>
  | null
  | undefined

function isAgentWorkspaceTrustOn(settings: AgentWorkspaceTrustSetting): boolean {
  return settings?.agentWorkspaceTrustEnabled !== false
}

/** Return null for no-op spawns: an extra async tick can reorder pane reservations. */
export function applyAgentWorkspaceTrustToSpawn(
  args: {
    launchAgent: unknown
    /** Worktree or folder workspace id; its root is the folder the agent is trusted in. */
    worktreeId: string | undefined
    /** The resolved folder the agent starts in; floating terminals have only this. */
    cwd: string | undefined
    store: { getFolderWorkspace: (id: string) => { folderPath: string } | undefined } | undefined
    isFreshLaunch: boolean
    settings: AgentWorkspaceTrustSetting
    spawnOptions: AgentTrustSpawnFields
  } & AgentTrustLaunchContext
): Promise<void> | null {
  if (!args.isFreshLaunch || !isAgentWorkspaceTrustOn(args.settings)) {
    return null
  }
  const preset = isTuiAgent(args.launchAgent)
    ? TUI_AGENT_CONFIG[args.launchAgent].preflightTrust
    : undefined
  if (!preset) {
    return null
  }
  const workspaceRoot = resolveTerminalWorkspacePath(
    args.worktreeId,
    (folderWorkspaceId) => args.store?.getFolderWorkspace(folderWorkspaceId)?.folderPath
  )
  const workspacePath = AGENT_TRUST_KEYED_BY_START_FOLDER[preset]
    ? args.cwd || workspaceRoot
    : workspaceRoot
  if (!workspacePath) {
    return null
  }
  return applyAgentWorkspaceTrust(preset, workspacePath, {
    env: args.env,
    claudeAuth: args.claudeAuth,
    wslDistro: args.wslDistro,
    connectionId: args.connectionId,
    codexHome: args.codexHome
  }).then((fields) => {
    if (fields.agentWorkspaceTrust) {
      args.spawnOptions.agentWorkspaceTrust = fields.agentWorkspaceTrust
    }
  })
}

/** Read-only Codex chats need explicit folder trust to load .codex config. */
export async function applyStructuredCodexWorkspaceTrust(args: {
  workspacePath: string
  launchEnv: Record<string, string | undefined>
  codexHome: string
  settings: AgentWorkspaceTrustSetting
}): Promise<void> {
  if (!isAgentWorkspaceTrustOn(args.settings)) {
    return
  }
  await applyAgentWorkspaceTrust('codex', args.workspacePath, {
    env: args.launchEnv,
    claudeAuth: null,
    wslDistro: null,
    connectionId: null,
    codexHome: args.codexHome
  })
}
