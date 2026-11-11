import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { ApprovalAnswerParams } from '../../../../../../shared/rpc-contract/orchestration-approval-answer-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { structuredMailboxCustody } from '../../../../orchestration/mailbox/routing/structured-session-mail-target'
import {
  answerChatWorkerApproval,
  chatApprovalCloseOutcome,
  readChatWorkerPrompt
} from '../../../../orchestration/workers/approvals/chat-worker-approval-prompt'
import {
  chatAnswerOutcome,
  closedApproval,
  workerApprovalPayload
} from '../../../../orchestration/workers/approvals/worker-approval'
import { closeReportedApproval } from '../../../../orchestration/workers/approvals/worker-approval-report'
import {
  reportWorkerApprovalClosed,
  stopReportId
} from '../../../../orchestration/workers/turn-stops/worker-turn-stop-report'
import type { z } from 'zod'
import type { RpcContext } from '../../../core'
import { workerApprovalAccess, type WorkerApprovalAccess } from './worker-approval-access'
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
    handler: (params, ctx, access) => answerWorkerApproval(params, ctx, access)
  })
]

/** Answers a worker's open approval as Orca, and closes the card at once when the prompt is already
 *  gone; the access check decided who may answer and with what reason. */
export async function answerWorkerApproval(
  params: z.infer<typeof ApprovalAnswerParams>,
  { runtime, orchestrationCaller }: Pick<RpcContext, 'runtime' | 'orchestrationCaller'>,
  access: WorkerApprovalAccess
): Promise<WorkerApprovalAnswerReceipt> {
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
  const notify = (handle: string, type: string): void => runtime.notifyMessageArrived(handle, type)
  const custody = structuredMailboxCustody(`dispatch:${dispatch.id}`, db)
  // A chat worker's prompt is its journal item; a terminal worker's is its waiting hook, if any.
  if (typeof custody !== 'object') {
    const answered = await runtime.terminalWorkerApprovals.answer({
      dispatchId: dispatch.id,
      approvalId: params.prompt,
      decision: params.decision,
      // Claude gives the model this text word for word, and the turn continues.
      message: access.reason ?? 'Denied by the owner.'
    })
    if (!answered.ok) {
      // A prompt Orca no longer holds (a restart, an ended hook) can never close on its own.
      if (
        answered.code === 'approval_not_open' &&
        !runtime.terminalWorkerApprovals.isHeld(params.prompt)
      ) {
        closeReportedApproval(
          db,
          dispatch,
          params.prompt,
          { by: 'unknown', decision: null, reason: null, reasonDelivered: true },
          { notify }
        )
      }
      throw new OrchestrationError(answered.code, answered.message, { effectsApplied: false })
    }
    reportWorkerApprovalClosed(
      db,
      dispatch,
      {
        from: worker,
        approval: closedApproval(answered.approval, {
          by: access.answeredBy,
          decision: params.decision,
          reason: access.reason,
          reasonDelivered: true
        })
      },
      { notify }
    )
    return {
      approvalId: params.prompt,
      dispatchId: dispatch.id,
      decision: params.decision,
      option: params.decision === 'allow' ? 'Allow' : 'Deny',
      reasonMessageId: null
    }
  }
  const answered = await answerChatWorkerApproval({
    sessionId: custody.sessionId,
    approvalId: params.prompt,
    dispatchId: dispatch.id,
    decision: params.decision
  })
  if (!answered.ok) {
    // Answered in the worker's own chat, or gone: say so now, not at the worker's next turn edge.
    if (answered.code === 'approval_not_open') {
      // An unreadable chat proves nothing about the prompt.
      const prompt = await readChatWorkerPrompt(custody.sessionId, params.prompt).catch(
        () => undefined
      )
      const outcome = prompt === undefined ? null : chatApprovalCloseOutcome(prompt)
      if (outcome) {
        closeReportedApproval(db, dispatch, params.prompt, outcome, { notify })
      }
    }
    throw new OrchestrationError(answered.code, answered.message, { effectsApplied: false })
  }
  // Chat prompts take no deny message, so a coordinator's reason reaches the worker as its next
  // mail, once. A person's Deny needs none: the agent was already told the user denied it.
  const reasonId = stopReportId(dispatch.id, `approval:${params.prompt}:reason`)
  const reasonMessage =
    params.decision === 'deny' && access.answeredBy === 'coordinator' && access.reason
      ? (db.getMessageById(reasonId) ??
        db.insertMessage({
          id: reasonId,
          from:
            params.from ??
            (orchestrationCaller?.orcaSessionId
              ? formatOrcaSessionAddress(orchestrationCaller.orcaSessionId)
              : `run:${dispatch.run_id}`),
          to: `dispatch:${dispatch.id}`,
          subject: `Denied: ${answered.prompt.body.displayName ?? answered.prompt.body.title}`,
          body: access.reason,
          runId: dispatch.run_id
        }))
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
        outcome: chatAnswerOutcome({
          by: access.answeredBy,
          decision: params.decision,
          reason: access.reason,
          reasonMailed: reasonMessage !== null
        })
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
