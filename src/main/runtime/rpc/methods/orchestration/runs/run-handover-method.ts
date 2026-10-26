import { defineMethod } from '../../../core'
import { RunHandoverParams } from '../../../../../../shared/rpc-contract/orchestration-runs-params'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { issueRunHandover } from '../../../../orchestration/db/runs/run-handover'
import { resolveOrchestrationCaller } from './run-scope'
import { resolveRunCallerKey } from './run-caller-key'
import {
  formatOrcaSessionAddress,
  parseOrcaSessionAddress
} from '../../../../../../shared/orca-session-address'
import { readAgentSessionRecordStore } from '../../../../orchestration/structured-session-lineage'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { refuseUndeliverableSessionRecipient } from '../messaging/session-recipient'

export const RUN_HANDOVER_METHOD = defineMethod({
  name: 'orchestration.runHandover',
  permission: 'workspace',
  params: RunHandoverParams,
  handler: async (
    params,
    { runtime, orchestrationCaller, orchestrationCompatibilityEvidence, recordMutationReceipt }
  ) => {
    const db = runtime.getOrchestrationDb()
    if (parseOrcaSessionAddress(params.to ?? '')) {
      await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    }
    const party = resolveOrchestrationParty(params.to ?? '', db)
    if (!params.toTask && party.terminalHandle === null && party.orcaSessionId !== null) {
      const refusal = refuseUndeliverableSessionRecipient(
        { sessionId: party.orcaSessionId, address: formatOrcaSessionAddress(party.orcaSessionId) },
        readAgentSessionRecordStore(),
        db,
        'No effects were applied.'
      )
      if (refusal) {
        throw new OrchestrationError(refusal.code, refusal.message, { effectsApplied: false })
      }
    }
    const caller = resolveOrchestrationCaller(runtime, {
      callerTerminalHandle: params.from,
      callerSession: orchestrationCaller,
      callerEvidence: orchestrationCompatibilityEvidence,
      requireStablePane: true
    })
    const target = params.toTask
      ? { taskId: params.toTask }
      : {
          caller: resolveRunCallerKey(runtime, party)
        }
    return issueRunHandover(db, {
      runId: params.id,
      caller: resolveRunCallerKey(runtime, caller),
      target,
      recordReceipt: recordMutationReceipt
    })
  }
})
