import type { z } from 'zod'
import type { SendParams } from './send-params'
import type { RpcContext } from '../../../core'
import type { OrchestrationPartyIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { runBoundToCoordinator } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { structuredMailboxCustody } from '../../../../orchestration/mailbox/routing/structured-session-mail-target'
import { getStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'

export async function resumeWorkerFailure(
  params: z.infer<typeof SendParams>,
  ctx: Pick<RpcContext, 'runtime' | 'orchestrationMutation'>,
  caller: OrchestrationPartyIdentity | undefined
) {
  const { runtime } = ctx
  const db = runtime.getOrchestrationDb()
  const to = params.to
  if (
    !to?.startsWith('dispatch:') ||
    !params.expectedFailureId ||
    !caller ||
    !ctx.orchestrationMutation
  ) {
    throw new OrchestrationError(
      'forbidden',
      'Resume needs the worker’s coordinator, exact Dispatch and failure id from its held receipt.',
      { effectsApplied: false }
    )
  }
  const dispatchId = to.slice('dispatch:'.length)
  const dispatch = db.getDispatchContextById(dispatchId)
  const custody = structuredMailboxCustody(to, db)
  if (!dispatch || dispatch.status !== 'dispatched' || typeof custody !== 'object') {
    throw new OrchestrationError(
      'worker_resume_unavailable',
      'This worker cannot be resumed here. Its messages remain held.',
      { effectsApplied: false }
    )
  }
  const authorize = () => {
    const current = db.getDispatchContextById(dispatchId)
    const run = current && db.getRun(current.run_id)
    const reaches = structuredMailboxCustody(to, db)
    if (
      !current ||
      current.status !== 'dispatched' ||
      current.process_incarnation !== dispatch.process_incarnation ||
      current.assignee_handle !== dispatch.assignee_handle ||
      !run ||
      !runBoundToCoordinator(run, caller) ||
      typeof reaches !== 'object' ||
      reaches.sessionId !== custody.sessionId
    ) {
      throw new OrchestrationError(
        'forbidden',
        'Only this Dispatch’s current coordinator can resume this worker.',
        { effectsApplied: false }
      )
    }
  }
  authorize()
  const host = getStructuredAgentSessionHost()
  const fence = host?.deps.store.getConversation(custody.sessionId)?.currentFence
  if (!host || fence === undefined) {
    throw new OrchestrationError(
      'worker_resume_unavailable',
      'The worker is not attached here. Its messages remain held.',
      { effectsApplied: false }
    )
  }
  const operationId = `${ctx.orchestrationMutation.callerFingerprint}:${ctx.orchestrationMutation.requestId}`
  const result = await host.resumeFailure(
    custody.sessionId,
    {
      expectedFailureId: params.expectedFailureId,
      expectedRuntimeFence: fence,
      operationId,
      dispatchId,
      coordinatorId: caller.address,
      ...(params.subject || params.body ? { hasMessage: true as const } : {})
    },
    authorize
  )
  if (result.status !== 'resumed' && result.status !== 'not-failed') {
    const heldCount = result.waiting
      ? ` ${result.waiting} ${result.waiting === 1 ? 'message' : 'messages'} still held.`
      : ''
    throw new OrchestrationError(
      `worker_resume_${result.status}`,
      result.status === 'message-attached'
        ? `Resume the held messages without --subject or --body, then send a follow-up.${heldCount}`
        : result.status === 'stale-failure'
          ? `This failure id is out of date. Nothing was resumed.${heldCount}`
          : result.status === 'already-used'
            ? `This worker was already resumed once after its error. Ask the owner to resume it.${heldCount}`
            : `This worker needs its owner before it can resume.${heldCount}`,
      {
        ...result,
        delivered: false,
        expectedFailureId: params.expectedFailureId,
        target: { sessionId: custody.sessionId, dispatchId },
        effectsApplied: false
      }
    )
  }
  if (result.status === 'not-failed' && params.subject) {
    return null
  }
  const goingNext = result.waiting - (result.stillHeld ?? 0)
  return {
    delivered: false as const,
    state: result.status === 'resumed' ? ('resuming' as const) : ('idle' as const),
    recovery: result,
    target: { sessionId: custody.sessionId, dispatchId },
    recoveryMessage:
      result.status === 'resumed'
        ? `Resuming ${dispatch.assignee_handle ?? dispatchId}.${goingNext ? ` ${goingNext} held ${goingNext === 1 ? 'message goes' : 'messages go'} next.` : ''}${result.stillHeld ? ` ${result.stillHeld} ${result.stillHeld === 1 ? 'message' : 'messages'} still held.` : ''}`
        : ''
  }
}
