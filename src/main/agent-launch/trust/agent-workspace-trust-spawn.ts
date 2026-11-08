import { TUI_AGENT_CONFIG, isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { resolveTerminalWorkspacePath } from '../../../shared/shell/launch/terminal-startup-cwd'
import {
  applyAgentWorkspaceTrust,
  type AgentTrustLaunchContext,
  type AgentTrustSpawnFields
} from './agent-workspace-trust'
import { AGENT_TRUST_KEYED_BY_START_FOLDER } from './execution-host-workspace-trust'
import type { Repo } from '../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { splitWorktreeId } from '../../../shared/worktree/id'
import {
  shouldPreTrustAgentWorkspace,
  resolveAgentWorkspaceTrustOwner,
  type AgentWorkspaceTrustDecision
} from '../../../shared/agent-launch/permissions/agent-workspace-trust-decision'

type AgentWorkspaceTrustSetting =
  | Partial<Pick<GlobalSettings, 'agentWorkspaceTrustEnabled'>>
  | null
  | undefined

export type AgentWorkspaceTrustRepoLookup = {
  getRepo?: (repoId: string) => Pick<Repo, 'agentWorkspaceTrust'> | undefined
}

/** Folder workspaces and floating terminals have no repo, so only the global setting applies. */
export function agentWorkspaceTrustDecisionForWorkspace(
  workspaceId: string | undefined,
  store: AgentWorkspaceTrustRepoLookup | undefined
): AgentWorkspaceTrustDecision | undefined {
  const scope = workspaceId ? parseWorkspaceKey(workspaceId) : null
  if (!workspaceId || scope?.type === 'folder') {
    return undefined
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = splitWorktreeId(worktreeId)?.repoId
  return repoId ? store?.getRepo?.(repoId)?.agentWorkspaceTrust : undefined
}

/** Return null for no-op spawns: an extra async tick can reorder pane reservations. */
export function applyAgentWorkspaceTrustToSpawn(
  args: {
    launchAgent: unknown
    /** The user chose "let agents ask" for this launch; it wins even if saving that answer failed. */
    skipForThisLaunch?: boolean
    /** Placement workspace id; its root may differ from the agent’s starting folder. */
    worktreeId: string | undefined
    /** Section root to pre-trust for this launch; never part of the terminal identity. */
    trustWorktreeId?: string
    /** The resolved folder the agent starts in; floating terminals have only this. */
    cwd: string | undefined
    store:
      | ({
          getFolderWorkspace: (id: string) => { folderPath: string } | undefined
        } & AgentWorkspaceTrustRepoLookup)
      | undefined
    isFreshLaunch: boolean
    settings: AgentWorkspaceTrustSetting
    spawnOptions: AgentTrustSpawnFields
  } & AgentTrustLaunchContext
): Promise<void> | null {
  const trustWorkspaceId = resolveAgentWorkspaceTrustOwner(args)
  if (
    !args.isFreshLaunch ||
    args.skipForThisLaunch === true ||
    !shouldPreTrustAgentWorkspace(
      args.settings?.agentWorkspaceTrustEnabled,
      agentWorkspaceTrustDecisionForWorkspace(trustWorkspaceId, args.store)
    )
  ) {
    return null
  }
  const preset = isTuiAgent(args.launchAgent)
    ? TUI_AGENT_CONFIG[args.launchAgent].preflightTrust
    : undefined
  if (!preset) {
    return null
  }
  const workspaceRoot = resolveTerminalWorkspacePath(
    trustWorkspaceId,
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
  repoDecision: AgentWorkspaceTrustDecision | undefined
}): Promise<void> {
  if (!shouldPreTrustAgentWorkspace(args.settings?.agentWorkspaceTrustEnabled, args.repoDecision)) {
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
