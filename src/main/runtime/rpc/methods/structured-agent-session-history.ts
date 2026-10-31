import { defineMethod } from '../core'
import { HistoryParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
import { requireInstalledStructuredHost as requireInstalledHost } from './structured-agent-session-gate'
import { clientReadsSettledBodies } from './structured-agent-session-item'
import { clientSupportsSnapshotCatchUp } from './structured-agent-session-history-capability'
import { clientReadsCurrentRequests } from './structured-agent-session-current-requests'
import { projectTurnItemHistory } from './structured-agent-session-turn-item-capability'
import { projectQueuedImageCardHistory } from './structured-agent-session-queued-image-capability'
import { projectBackgroundTaskHistory } from './structured-agent-session-background-task-capability'

export const STRUCTURED_AGENT_SESSION_HISTORY_METHODS = [
  defineMethod({
    name: 'agentSession.history',
    permission: 'workspace',
    params: HistoryParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledHost(ctx, params.sessionId)
      return projectTurnItemHistory(
        projectQueuedImageCardHistory(
          projectBackgroundTaskHistory(
            await host.history(
              params,
              undefined,
              clientSupportsSnapshotCatchUp(ctx) && clientReadsCurrentRequests(ctx),
              clientReadsSettledBodies(ctx)
            ),
            ctx
          ),
          ctx
        ),
        ctx,
        host.sessionAgent(params.sessionId)
      )
    }
  })
]
