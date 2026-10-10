import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionStopTarget } from '../../../shared/agent-session-stop-target'
import { targetedAgentSessionBackgroundTaskIds } from '../../../shared/agent-session-background-stop-target'
import type {
  AgentSessionCancelResult,
  AgentSessionMutationEnvelope
} from '../../../shared/agent-session-wire'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import { performCancel } from './structured-agent-session-turns'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'

type BackgroundStopObservation =
  | { verdict: 'live'; children: readonly AgentChildWorkView[] }
  | { verdict: 'exited' }
  | { verdict: 'unverifiable' }

export function cancelPlan(params: {
  envelope: AgentSessionMutationEnvelope
  turnId?: string
  scope?: 'background-tasks'
  taskId?: string
  stopTarget?: AgentSessionStopTarget
  prompt?: { itemId: string; expectedRevision: number }
  /** The session's child records, which name the tasks a background Stop reaches. */
  childWork?: () => readonly AgentChildWorkView[] | undefined
}): MutationPlan<AgentSessionCancelResult> {
  const observeBackgroundTarget = (): BackgroundStopObservation | undefined => {
    if (params.scope !== 'background-tasks' || params.stopTarget?.kind !== 'background-tasks') {
      return undefined
    }
    const children = params.childWork?.()
    if (children === undefined) {
      return { verdict: 'unverifiable' }
    }
    return targetedAgentSessionBackgroundTaskIds(children, params.stopTarget, params.taskId)
      .length > 0
      ? { verdict: 'live', children }
      : { verdict: 'exited' }
  }
  // Admission and execution share the observation; an exempt no-op can never become a provider write.
  let backgroundObservation: BackgroundStopObservation | undefined
  const admissionObservation = () => (backgroundObservation ??= observeBackgroundTarget())
  return {
    method: 'agentSession.cancel',
    // An ended target needs no writer; a real background stop still checks execution ownership.
    get conversationWrite() {
      return (!params.scope && !params.prompt) || admissionObservation()?.verdict === 'exited'
        ? true
        : undefined
    },
    // A Stop must reach the agent even when storage refuses the row recording it.
    runsWithoutLedgerRow: true,
    ...(params.stopTarget ? { receiptPolicy: 'none' as const } : {}),
    fields: {
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.stopTarget ? { stopTarget: params.stopTarget } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {})
    },
    run: async (ctx) => {
      const admitted = admissionObservation()
      // Unavailable evidence already paid the writer check; retry through the same host authority.
      const observed = admitted?.verdict === 'unverifiable' ? observeBackgroundTarget() : admitted
      if (observed?.verdict === 'unverifiable') {
        return {
          ok: false,
          refusal: agentSessionOperationOutcomeUnknown(params.envelope.clientOperationId)
        }
      }
      if (observed?.verdict === 'exited') {
        return {
          ok: true,
          value: {
            ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
            cancelled: false
          }
        }
      }
      return performCancel(ctx, {
        clientOperationId: params.envelope.clientOperationId,
        ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
        ...(params.taskId ? { taskId: params.taskId } : {}),
        ...(params.stopTarget?.kind === 'background-tasks'
          ? { backgroundStopTarget: params.stopTarget }
          : {}),
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(observed?.verdict === 'live'
          ? { childWork: () => observed.children }
          : params.childWork
            ? { childWork: params.childWork }
            : {})
      })
    },
    // Interrupting twice would kill a turn the client never asked to stop, so a
    // replay reports the turn as already handled.
    replay: () => ({
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      cancelled: false
    })
  }
}
