import type { OrcaRuntimeService } from '../../orca-runtime'
import type { PipelineV2Ports } from './pipeline-v2-execution'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { readPipelineV2Response } from './pipeline-v2-response'

export function pipelineV2ResponsePorts(
  runtime: OrcaRuntimeService
): Pick<PipelineV2Ports, 'response' | 'completeResponse'> {
  const db = runtime.getOrchestrationDb()
  return {
    response: async (invocation, messageId) => {
      const session = invocation.session
      const host = getStructuredAgentSessionHost()
      if (session?.kind !== 'structured' || !host) {
        return { state: 'unverifiable' }
      }
      const journal = (await host.conversation(session.sessionId)).journal
      const { snapshot } = await journal.reads.operationWindow({
        operationIds: [messageId],
        anchorsOnly: true,
        withoutTurnAhead: true,
        throughAnchoredTurns: true,
        withoutToolOutput: true,
        turnShape: true
      })
      const accepted = snapshot.submissions.filter((value) => value.dispatchState === 'accepted')
      if (
        accepted.length === 1 &&
        accepted[0].acceptedSequence !== undefined &&
        (await journal.reads.input({ kind: 'sent-after', sequence: accepted[0].acceptedSequence }))
          .answer
      ) {
        return { state: 'unverifiable' }
      }
      const work = await host.currentWorkAtRest(session.sessionId)
      if (!work || !work.allowsObservation()) {
        return { state: 'unverifiable' }
      }
      if (work.working()) {
        return { state: 'pending' }
      }
      return readPipelineV2Response(snapshot, messageId)
    },
    completeResponse: async (invocation, result) => {
      const dispatch = invocation.dispatchId && db.getDispatchContextById(invocation.dispatchId)
      if (
        !dispatch ||
        invocation.session?.kind !== 'structured' ||
        dispatch.assignee_orca_session_id !== invocation.session.sessionId
      ) {
        throw new Error('pipeline_response_dispatch_conflict')
      }
      const settled = db.settleWorkerReport({
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        outcome: result?.status === 'result' ? 'succeeded' : 'failed',
        result: result?.summary ?? 'Agent turn ended without a valid stage result'
      })
      if (settled.action !== 'settled') {
        throw new Error('pipeline_response_settlement_unconfirmed')
      }
    }
  }
}
