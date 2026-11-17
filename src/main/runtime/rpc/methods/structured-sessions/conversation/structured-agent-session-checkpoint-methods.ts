// Per-turn file checkpoints: what restoring a message's snapshot would change, the restore itself
// (which first saves an undo point), and undoing that restore. Same host code locally and on VMs.

import { realpath } from 'node:fs/promises'
import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import type { AgentSessionWorkspaceBusy } from '../../../../../native-chat/agent-session-wire/checkpoints/agent-session-checkpoints'
import { hostAgentSessionCheckpoints } from '../../../../../native-chat/agent-session-wire/checkpoints/agent-session-checkpoints-host'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { RpcContext } from '../../../core'
import {
  CheckpointItemParams,
  CheckpointUndoParams
} from '../../../../../../shared/rpc-contract/structured-agent-session-checkpoint-params'

/** Any agent working in the chat's workspace (terminal agents included) may be writing files.
 *  Rows match by workspace id or by worktree path; a truncated listing can't prove the workspace
 *  idle, so it counts as busy. */
function terminalAgentsWorking(ctx: RpcContext, sessionId: string): AgentSessionWorkspaceBusy {
  return async (root) => {
    const workspaceId =
      getStructuredAgentSessionHost()?.deps.store.getRecord(sessionId)?.location.workspaceId
    const ps = await ctx.runtime.getWorktreePs(10_000)
    if (ps.truncated) {
      return true
    }
    const rootReal = await realpath(root).catch(() => root)
    for (const row of ps.worktrees) {
      const sameRow =
        row.worktreeId === workspaceId ||
        (await realpath(row.path).catch(() => row.path)) === rootReal
      if (sameRow && row.agents.some((agent) => agent.state === 'working')) {
        return true
      }
    }
    return false
  }
}

export const STRUCTURED_AGENT_SESSION_CHECKPOINT_METHODS = [
  defineMethod({
    name: 'agentSession.checkpointPreview',
    permission: 'workspace',
    params: CheckpointItemParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).preview(params.sessionId, params.itemId, terminalAgentsWorking(ctx, params.sessionId))
  }),
  defineMethod({
    name: 'agentSession.checkpointRestore',
    permission: 'workspace',
    params: CheckpointItemParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(
        await requireInstalledStructuredHost(ctx, params.sessionId)
      ).restore(params.sessionId, params.itemId, terminalAgentsWorking(ctx, params.sessionId))
  }),
  defineMethod({
    name: 'agentSession.checkpointUndo',
    permission: 'workspace',
    params: CheckpointUndoParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(await requireInstalledStructuredHost(ctx, params.sessionId)).undo(
        params.sessionId,
        params.undoId,
        terminalAgentsWorking(ctx, params.sessionId)
      )
  })
]
