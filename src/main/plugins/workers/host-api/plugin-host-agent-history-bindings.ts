import { z } from 'zod'
import { PLUGIN_HOST_API } from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_AGENT_SESSION_LIST_DEFAULT,
  PLUGIN_AGENT_SESSION_TITLE_MAX
} from '../../../../shared/plugins/workers/plugin-host-api-agent-history'
import { pluginAgentSessionIdSchema } from '../../../../shared/plugins/workers/plugin-host-api-panel-methods'
import { pluginWorkspaceId } from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  aiVaultHistoryAgents,
  isAiVaultAgent
} from '../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  bind,
  type BoundPluginHostMethod,
  type PluginHostMethodContext
} from './plugin-host-method-bind'
import { PluginHostCallError } from './plugin-host-call-scope'
import {
  pluginHostRpc as rpc,
  pluginWorkspaceSelector as workspaceSelector
} from './plugin-host-runtime-call'
import { listPluginWorkspaces } from './plugin-host-workspace-list'
import {
  isLocalHistoryWorkspace,
  pluginAgentHistory,
  pluginHistoryWorkspaceMatcher,
  type PluginHistorySession,
  type PluginHistoryWorkspace
} from './plugin-agent-history'
import type { PluginAgentStatusRow } from './plugin-workspace-projection'

const worktreeShowAnswer = z.object({
  worktree: z.object({ id: z.string(), identity: z.object({ key: z.string() }).optional() })
})

/** One line, at most the public bound: a title can be the start of a multi-line first message. */
function sessionTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, PLUGIN_AGENT_SESSION_TITLE_MAX)
}

/** The workspace `workspaceId` names, as `workspace.list` lists it, in either id form. */
async function namedWorkspace(
  ctx: PluginHostMethodContext,
  workspaces: readonly PluginHistoryWorkspace[],
  workspaceId: string
): Promise<PluginHistoryWorkspace> {
  const listed = workspaces.find((row) => row.id === workspaceId)
  if (listed) {
    return listed
  }
  // A raw id of a workspace `workspace.list` names by its identity.
  const { worktree } = worktreeShowAnswer.parse(
    await rpc(ctx.services)('worktree.show', {
      worktree: workspaceSelector(workspaceId),
      matchFolderWorkspaces: true
    })
  )
  const id = pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key })
  const shown = workspaces.find((row) => row.id === id)
  if (!shown) {
    throw new PluginHostCallError('action_failed', 'no workspace has this id')
  }
  return shown
}

/** The sessions Orca panes on this computer run now, by agent and session id. */
function runningSessions(rows: readonly PluginAgentStatusRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.providerSessionOnly !== true && !row.connectionId && row.providerSession)
      .map((row) => `${row.agentType ?? ''}\0${row.providerSession?.id ?? ''}`)
  )
}

/** One OpenCode store holds both versions' sessions, which panes and history may label apart. */
function isRunning(session: PluginHistorySession, running: ReadonlySet<string>): boolean {
  const agents = isAiVaultAgent(session.agent)
    ? aiVaultHistoryAgents(session.agent)
    : [session.agent]
  return agents.some((agent) => running.has(`${agent}\0${session.sessionId}`))
}

function publicSession(
  session: PluginHistorySession,
  workspaceId: string | null,
  running: ReadonlySet<string>
) {
  return {
    sessionId: session.sessionId,
    agent: session.agent.slice(0, 128),
    title: sessionTitle(session.title),
    workspaceId,
    hostId: session.hostId,
    branch: session.branch?.replace(/^refs\/heads\//, '').slice(0, 512) || null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
    totalTokens: session.totalTokens,
    running: isRunning(session, running)
  }
}

export const PLUGIN_AGENT_HISTORY_HANDLERS = {
  'agent.listSessions': bind(PLUGIN_HOST_API['agent.listSessions'], async (params, ctx) => {
    const call = rpc(ctx.services)
    const limit = params?.limit ?? PLUGIN_AGENT_SESSION_LIST_DEFAULT
    const { workspaces } = await listPluginWorkspaces(call, false)
    const scope = params?.workspaceId
      ? await namedWorkspace(ctx, workspaces, params.workspaceId)
      : null
    // Orca reads only this computer's history; another host's workspace has none here.
    if (scope && !isLocalHistoryWorkspace(scope)) {
      return { sessions: [], truncated: false }
    }
    const owner = ctx.services.runtimeRpc ?? call
    const history = await pluginAgentHistory(call, owner, scope?.path ?? null)
    const workspaceOf = await pluginHistoryWorkspaceMatcher(workspaces)
    const running = runningSessions(ctx.services.listAgentStatuses())
    const matching = history.sessions
      .filter((session) => pluginAgentSessionIdSchema.safeParse(session.sessionId).success)
      .map((session) => ({ session, workspaceId: workspaceOf(session) }))
      // A folder holds the worktrees nested in it; their sessions are theirs.
      .filter((row) => !scope || row.workspaceId === scope.id)
    return {
      sessions: matching
        .slice(0, limit)
        .map(({ session, workspaceId }) => publicSession(session, workspaceId, running)),
      truncated: matching.length > limit || history.depthReached
    }
  })
} satisfies Record<string, BoundPluginHostMethod>

/**
 * The history row `agent.resume` prepares for a session no Orca pane runs: the workspace's own
 * sessions first, then this computer's newest. Null when the history lists none, or the workspace
 * is on another host.
 */
export async function findPluginPastSession(
  ctx: PluginHostMethodContext,
  match: { agents: readonly string[]; sessionId: string; workspacePath: string | null }
): Promise<PluginHistorySession | null> {
  const call = rpc(ctx.services)
  const owner = ctx.services.runtimeRpc ?? call
  for (const scopePath of match.workspacePath ? [match.workspacePath, null] : [null]) {
    const { sessions } = await pluginAgentHistory(call, owner, scopePath)
    const found = sessions.find(
      (session) =>
        session.hostId === LOCAL_EXECUTION_HOST_ID &&
        session.sessionId === match.sessionId &&
        match.agents.includes(session.agent)
    )
    if (found) {
      return found
    }
  }
  return null
}
