import type { StructuredAgentSessionSendAcceptance } from '../operations/structured-agent-session-turns'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'
import type { AgentSessionResumeSelection } from '../../../runtime/agent-session/records/agent-session-recovery-capsule'
import type { RestartAttempt } from './structured-agent-session-restart-attempt'
import { buildCommandReceiptTransaction } from '../../agent-session-journal/writing/command-receipt-transaction'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import { STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER } from './structured-agent-session-restart-resume-wiring'
import { restartContinuationEnvelope } from './structured-agent-session-restart-continuation-envelope'
import {
  RestartContinuationDeferredError,
  RestartContinuationSupersededError
} from './structured-agent-session-restart-continuation'

/** Take the capsule lock only after the send owns its session lane and has finished preparation. */
export function restartSendAcceptance(input: {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'recoveryCapsule'>
  selection: AgentSessionResumeSelection
  attempt: Extract<RestartAttempt, { kind: 'send' }>
  stillWanted: () => boolean
  stopping: () => boolean
  now: () => number
  fence: () => number | null
}): StructuredAgentSessionSendAcceptance {
  const { deps, selection, attempt, stillWanted } = input
  const { marker } = selection
  return async (apply) => {
    let reached = false
    const result = await deps
      .recoveryCapsule!.withSelectedResume(selection, input.now(), async () => {
        reached = true
        if (input.stopping()) {
          throw new RestartContinuationDeferredError()
        }
        if (!stillWanted()) {
          throw new RestartContinuationSupersededError()
        }
        const outcome = await apply()
        if (!outcome.ok && conclusiveRestartRefusal(outcome.refusal)) {
          const read = deps.store.readCommandReceipt({ kind: 'global' }, attempt.id)
          if (read.verdict === 'absent') {
            const prepared = restartContinuationEnvelope(
              marker.sessionId,
              input.fence()!,
              marker,
              attempt.id,
              attempt.body
            )
            await deps.store.commitOperationReceipt(
              buildCommandReceiptTransaction({ kind: 'global' }, () => ({
                operationId: attempt.id,
                sessionId: marker.sessionId,
                callerKey: STRUCTURED_AGENT_SESSION_RESTART_CONTINUATION_CALLER,
                method: 'agentSession.send',
                fingerprint: prepared.envelope.payloadFingerprint,
                status: 'rejected',
                acceptedAt: input.now(),
                rejection: {
                  reference: agentSessionRefusalReference(outcome.refusal),
                  message: outcome.refusal.message
                }
              }))
            )
          }
        }
        return outcome
      })
      .catch((error: unknown) => {
        if (!reached) {
          throw new RestartContinuationDeferredError()
        }
        throw error
      })
    if (!result.selected) {
      throw new RestartContinuationSupersededError()
    }
    return result.value
  }
}

/** Refusals that prove a bad request cannot become valid by merely waiting for this host. */
function conclusiveRestartRefusal(refusal: AgentSessionWireRefusal): boolean {
  return (
    refusal.code === 'agent_session_operation_invalid' &&
    [
      'requestMalformed',
      'attachmentExpired',
      'optionRejected',
      'providerRejected',
      'savedConversationMissing',
      'historyTooLarge',
      'agentCommandNotRunnable',
      'runtimeNotInstalled',
      'launchFolderMissing'
    ].includes(refusal.details?.reason ?? '')
  )
}
