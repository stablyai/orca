import type { z } from 'zod'
import type { ApprovalAnswerParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-approval-answer-params'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isAgentRpcCaller } from '../../../callers/rpc-caller-identity'
import { ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { OrchestrationAccessRuleInput } from './orchestration-method-access'
import type { RpcContext } from '../../../core'

/** A person, proven by the transport: the desktop app's own IPC, a phone's pairing, or a paired
 *  window that says so; never the orca CLI, an agent session, or a paired Orca's forwarded call. */
export function isPersonCaller(
  ctx: Pick<RpcContext, 'caller' | 'orchestrationCaller' | 'clientKind' | 'clientCapabilities'>
): boolean {
  return (
    ctx.caller?.kind === 'desktop' ||
    (ctx.caller?.kind === 'paired-device' &&
      !isAgentRpcCaller(ctx.caller) &&
      ctx.orchestrationCaller === undefined &&
      // Only the phone app holds a phone's pairing; a paired window says it is one.
      (ctx.clientKind === 'mobile' ||
        ctx.clientCapabilities?.includes(ORCHESTRATION_PERSON_APPROVALS_CLIENT_CAPABILITY) ===
          true))
  )
}

export type WorkerApprovalAccess = { answeredBy: 'person' | 'coordinator'; reason: string | null }

/** Approve requires a person, or an agent caller when the user's setting is on; deny allows an agent
 *  or a person. A person is proven by the transport: the desktop app's own IPC, a phone's pairing, or
 *  a paired window that says so; the orca CLI never does, so an older CLI fails closed. An agent session and a
 *  paired Orca's forwarded call are agents. The setting read is this machine's, which runs the worker. */
export function workerApprovalAccess({
  params,
  ctx
}: OrchestrationAccessRuleInput<z.infer<typeof ApprovalAnswerParams>>): WorkerApprovalAccess {
  const person = isPersonCaller(ctx)
  const reason = params.reason?.trim() || null
  // Without a reason it is not a coordinator's approve.
  if (
    params.decision === 'allow' &&
    !person &&
    !(reason && ctx.runtime.coordinatorApprovalsEnabled())
  ) {
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
