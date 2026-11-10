import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { ApprovalAnswerParams } from '../../../../../../shared/rpc-contract/orchestration-approval-answer-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { structuredMailboxCustody } from '../../../../orchestration/mailbox/routing/structured-session-mail-target'
import { answerChatWorkerApproval } from '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'
import { workerApprovalPayload } from '../../../../orchestration/workers/approvals/worker-approval'
import { reportWorkerApprovalClosed } from '../../../../orchestration/workers/turn-stops/worker-turn-stop-report'
import { workerApprovalAccess } from './worker-approval-access'
import { formatOrcaSessionAddress } from '../../../../../../shared/orca-session-address'

export type WorkerApprovalAnswerReceipt = {
  approvalId: string
  dispatchId: string
  decision: 'allow' | 'deny'
  /** The worker's own label for the option Orca picked. */
  option: string
  /** The agent's prompt takes no message, so a deny's reason went to the worker as mail. */
  reasonMessageId: string | null
}

export const ORCHESTRATION_WORKER_APPROVAL_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.approvalAnswer',
    permission: 'workspace',
    params: ApprovalAnswerParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { dispatch: 'dispatch' },
      rule: workerApprovalAccess
    },
    handler: async (
      params,
      { runtime, orchestrationCaller },
      access
    ): Promise<WorkerApprovalAnswerReceipt> => {
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      const worker = dispatch?.assignee_handle
      if (!dispatch || !worker || dispatch.status !== 'dispatched') {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${params.dispatch} is not running, so it has no prompt to answer.`,
          { effectsApplied: false }
        )
      }
      const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
      // Only a chat worker's prompt is a record Orca can answer; others stay with the person.
      if (typeof custody !== 'object') {
        throw new OrchestrationError(
          'approval_unsupported',
          `Orca cannot answer this worker's prompts. A person must answer ${params.prompt} where the worker runs.`,
          { effectsApplied: false }
        )
      }
      const answered = await answerChatWorkerApproval({
        sessionId: custody.sessionId,
        approvalId: params.prompt,
        dispatchId: dispatch.id,
        decision: params.decision
      })
      if (!answered.ok) {
        throw new OrchestrationError(answered.code, answered.message, { effectsApplied: false })
      }
      const notify = (handle: string, type: string): void =>
        runtime.notifyMessageArrived(handle, type)
      // Chat prompts take no deny message, so the reason reaches the worker as its next mail.
      const reasonMessage =
        params.decision === 'deny' && access.reason
          ? db.insertMessage({
              from:
                params.from ??
                (orchestrationCaller
                  ? formatOrcaSessionAddress(orchestrationCaller.orcaSessionId)
                  : `run:${dispatch.run_id}`),
              to: `dispatch:${dispatch.id}`,
              subject: `Denied: ${answered.prompt.body.displayName ?? answered.prompt.body.title}`,
              body: access.reason,
              runId: dispatch.run_id
            })
          : null
      if (reasonMessage) {
        notify(reasonMessage.to_handle, reasonMessage.type)
      }
      reportWorkerApprovalClosed(
        db,
        dispatch,
        {
          from: worker,
          approval: workerApprovalPayload({
            approvalId: params.prompt,
            item: answered.prompt.body,
            worker: {
              handle: worker,
              dispatchId: dispatch.id,
              taskId: dispatch.task_id
            },
            outcome: {
              by: access.answeredBy,
              decision: params.decision,
              reason: access.reason,
              reasonDelivered: false
            }
          })
        },
        { notify }
      )
      return {
        approvalId: params.prompt,
        dispatchId: dispatch.id,
        decision: params.decision,
        option: answered.optionLabel,
        reasonMessageId: reasonMessage?.id ?? null
      }
    }
  })
]
