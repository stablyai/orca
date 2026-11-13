import { agentSessionFailureFact } from '../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session/failures/agent-session-failure-words'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { admitStructuredAgentSessionInput } from '../native-chat/agent-session-wire/delivery/structured-agent-session-input-admission'
import { traexMessageInput } from './traex-message-input'
import { traexRecord, traexText, traexTurnSchema, TraexRequestError } from './traex-protocol'
import type { TraexPendingSend, TraexSession } from './traex-session'
import { traexNativeExecutionSettings } from './traex-execution-settings'

type DispatchInput = Parameters<StructuredAgentSessionAdapter['dispatch']>[0]

export async function dispatchTraexMessage(
  session: TraexSession,
  input: DispatchInput
): ReturnType<StructuredAgentSessionAdapter['dispatch']> {
  const content = traexMessageInput(input.body)
  input.onInputPreparation?.()
  const options = { ...session.options, ...input.executionOptions }
  const nativeSettings = traexNativeExecutionSettings(session, options)
  const selected = options.model
    ? session.nativeModels.find(
        (model) => model.id === options.model || model.model === options.model
      )
    : undefined
  if (selected) {
    options.model = selected.id
  }
  if (
    session.activeTurn &&
    ((options.model && options.model !== session.ranOptions.model) ||
      (options.effort && options.effort !== session.ranOptions.effort) ||
      (options.interactionMode && options.interactionMode !== session.ranOptions.interactionMode))
  ) {
    throw new AgentSessionOptionRejectedError('TRAE CLI model changes apply to the next turn')
  }
  if (options.model && session.nativeModels.length && !selected) {
    throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this model')
  }
  await input.beforeDispatch?.()
  input.signal?.throwIfAborted()
  if (
    input.isCurrent?.() === false ||
    session.connection.closed ||
    !session.threadId ||
    !session.timeline
  ) {
    return {
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        agentName: 'TRAE CLI',
        surface: 'rejection'
      })
    }
  }
  input.onExecutionSnapshot?.()
  if (!session.activeTurn) {
    session.ranOptions = { ...options }
  }
  const send: TraexPendingSend = {
    clientMessageId: input.clientMessageId,
    requestedAt: input.requestedAt ?? Date.now(),
    unknown: false
  }
  const steer = session.activeTurn
  const params = steer
    ? {
        threadId: session.threadId,
        expectedTurnId: steer,
        input: content,
        userMessageId: input.clientMessageId
      }
    : {
        threadId: session.threadId,
        input: content,
        userMessageId: input.clientMessageId,
        ...nativeSettings
      }
  try {
    let response: Promise<unknown> | undefined
    await admitStructuredAgentSessionInput(input.admitFreshInput, () => {
      input.signal?.throwIfAborted()
      if (input.isCurrent?.() === false || session.connection.closed) {
        throw new Error('TRAE CLI child changed before dispatch')
      }
      session.pending.set(input.clientMessageId, send)
      response = session.connection.request(steer ? 'turn/steer' : 'turn/start', params, {
        onReply: (value) => {
          const result = traexRecord(value)
          const turnId = steer ? traexText(result.turnId) : traexTurnSchema.parse(result.turn).id
          if (!turnId) {
            throw new Error('TRAE CLI did not acknowledge a turn')
          }
          session.accept(send, turnId)
        }
      })
      // Attach before yielding to host admission so an early refusal is handled.
      void response.catch(() => undefined)
    })
    await response
  } catch (error) {
    if (!send.turnId) {
      if (error instanceof TraexRequestError) {
        session.pending.delete(input.clientMessageId)
        return {
          state: 'rejected',
          ...agentSessionFailureWords(agentSessionFailureFact('providerRejected'), {
            agentName: 'TRAE CLI',
            surface: 'rejection'
          })
        }
      }
      send.unknown = true
      return {
        state: 'unknown',
        reason: error instanceof Error ? error.message : 'TRAE CLI did not acknowledge the message'
      }
    }
  }
  if (!send.turnId) {
    send.unknown = true
    return { state: 'unknown', reason: 'TRAE CLI did not acknowledge the message' }
  }
  return {
    state: 'accepted',
    providerIdentity: { provider: 'orca', clientMessageId: input.clientMessageId },
    ranOptions: {
      ...(session.ranOptions.model ? { model: session.ranOptions.model } : {}),
      ...(session.ranOptions.effort ? { effort: session.ranOptions.effort } : {}),
      ...(session.ranOptions.interactionMode
        ? { interactionMode: session.ranOptions.interactionMode }
        : {})
    }
  }
}
