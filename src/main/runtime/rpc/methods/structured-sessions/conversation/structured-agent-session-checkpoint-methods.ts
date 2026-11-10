// Per-turn file checkpoints: what restoring a message's snapshot would change, the restore itself
// (which first saves an undo point), and undoing that restore. Same host code locally and on VMs.

import { defineMethod } from '../../../core'
import { requireInstalledStructuredHost } from '../creation/structured-agent-session-gate'
import { hostAgentSessionCheckpoints } from '../../../../../native-chat/agent-session-wire/checkpoints/agent-session-checkpoints'
import {
  CheckpointItemParams,
  CheckpointUndoParams
} from '../../../../../../shared/rpc-contract/structured-agent-session-checkpoint-params'

export const STRUCTURED_AGENT_SESSION_CHECKPOINT_METHODS = [
  defineMethod({
    name: 'agentSession.checkpointPreview',
    permission: 'workspace',
    params: CheckpointItemParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(await requireInstalledStructuredHost(ctx, params.sessionId)).preview(
        params.sessionId,
        params.itemId
      )
  }),
  defineMethod({
    name: 'agentSession.checkpointRestore',
    permission: 'workspace',
    params: CheckpointItemParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(await requireInstalledStructuredHost(ctx, params.sessionId)).restore(
        params.sessionId,
        params.itemId
      )
  }),
  defineMethod({
    name: 'agentSession.checkpointUndo',
    permission: 'workspace',
    params: CheckpointUndoParams,
    handler: async (params, ctx) =>
      hostAgentSessionCheckpoints(await requireInstalledStructuredHost(ctx, params.sessionId)).undo(
        params.sessionId,
        params.undoId
      )
  })
]
