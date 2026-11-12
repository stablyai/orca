import { isOrcaSessionId } from '../../../../../shared/orca-session-address'
import { SessionChildrenParams } from '../../../../../shared/rpc-contract/orchestration-params'
import { structuredSessionChildWorkers } from '../../../orchestration/structured-session-child-workers'
import { OrchestrationError } from '../../../orchestration/orchestration-error'
import { defineOrchestrationMethod } from './access/orchestration-method-access'
import { requireInstalledStructuredHost } from '../structured-sessions/creation/structured-agent-session-gate'
import { conversationRecordReader } from '../../../orchestration/addressing/session-lineage/structured-session-lineage'

export const ORCHESTRATION_SESSION_CHILDREN_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.sessionChildren',
    access: { kind: 'reads', targets: { sessionId: 'session' }, collection: true },
    permission: 'workspace',
    params: SessionChildrenParams,
    handler: async (params, ctx) => {
      if (!isOrcaSessionId(params.sessionId)) {
        throw new OrchestrationError(
          'session_history_unavailable',
          'The conversation has no Orca session identity.'
        )
      }
      const host = await requireInstalledStructuredHost(ctx, params.sessionId)
      return structuredSessionChildWorkers({
        ...params,
        sessionId: params.sessionId,
        db: ctx.runtime.getOrchestrationDb(),
        records: conversationRecordReader(host.deps.store)
      })
    }
  })
]
