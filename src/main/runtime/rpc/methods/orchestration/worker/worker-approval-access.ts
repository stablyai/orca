import type { z } from 'zod'
import type { ApprovalAnswerParams } from '../../../../../../shared/rpc-contract/orchestration-approval-answer-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationAccessRuleInput } from '../access/orchestration-method-access'

export type WorkerApprovalAccess = { answeredBy: 'person' | 'coordinator'; reason: string | null }

/** Approve requires a person; deny allows an agent or a person. A person is proven by the transport:
 *  only the desktop app's own IPC. A paired device can carry a remote CLI, so it counts as an agent. */
export function workerApprovalAccess({
  params,
  ctx
}: OrchestrationAccessRuleInput<z.infer<typeof ApprovalAnswerParams>>): WorkerApprovalAccess {
  const person = ctx.caller?.kind === 'desktop'
  const reason = params.reason?.trim() || null
  if (params.decision === 'allow' && !person) {
    throw new OrchestrationError(
      'approval_requires_person',
      `Only a person can allow ${params.prompt}, from Orca or the worker itself. You can deny it with a reason, or leave it for the person.`,
      { effectsApplied: false }
    )
  }
  if (!person && !reason) {
    throw new OrchestrationError(
      'invalid_argument',
      'Missing --reason: tell the worker what to do instead.',
      { effectsApplied: false }
    )
  }
  return { answeredBy: person ? 'person' : 'coordinator', reason }
}
