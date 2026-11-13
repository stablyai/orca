import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { providerDiagnostic } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from '../../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { readMessageText } from '../turns/zcode-message-text'
import type { ZcodeStructuredSession } from './zcode-structured-session'

// One zcode dispatch: choice application precedes the provider write, with the host's
// preparation and evidence checkpoints around the mutation window.

const DISPATCHABLE_OPTION_KEYS = ['model', 'effort', 'interactionMode']

export async function dispatchZcodeTurn(
  session: ZcodeStructuredSession,
  input: Parameters<StructuredAgentSessionAdapter['dispatch']>[0],
  requestTimeoutMs: number | null
): Promise<ReturnType<StructuredAgentSessionAdapter['dispatch']>> {
  session.dispatchPending = true
  try {
    const text = readMessageText(input.body)
    if (!text) {
      return {
        state: 'rejected' as const,
        ...agentSessionFailureWords(agentSessionFailureFact('emptyMessage'), {
          surface: 'rejection',
          agentName: 'ZCode'
        })
      }
    }
    // Stop or a lost acquisition between admission and here must not reach the provider.
    if (input.signal?.aborted || input.isCurrent?.() === false) {
      return {
        state: 'rejected' as const,
        ...agentSessionFailureWords(
          agentSessionFailureFact('providerRejected', {
            detail: providerDiagnostic('the chat stopped before the message was sent', 'person')
          }),
          { surface: 'rejection', agentName: 'ZCode' }
        )
      }
    }
    // Queued submission choices ride THIS dispatch: apply the supported subset before the
    // provider write, with the host's preparation and evidence checkpoints around them.
    const choices = input.executionOptions
    if (choices) {
      input.onInputPreparation?.()
      try {
        for (const [key, value] of Object.entries(choices)) {
          if (value === undefined || !DISPATCHABLE_OPTION_KEYS.includes(key)) {
            continue
          }
          await session.setOption(key, value, requestTimeoutMs)
        }
      } catch (error) {
        return {
          state: 'rejected' as const,
          ...agentSessionFailureWords(
            agentSessionFailureFact('providerRejected', {
              detail: providerDiagnostic(
                error instanceof Error ? error.message : String(error),
                'person'
              )
            }),
            { surface: 'rejection', agentName: 'ZCode' }
          )
        }
      }
      input.onExecutionSnapshot?.()
    }
    await input.beforeDispatch?.()
    return session.turns.dispatch({ clientMessageId: input.clientMessageId, text })
  } finally {
    session.dispatchPending = false
  }
}
