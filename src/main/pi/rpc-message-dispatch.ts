import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../shared/agent-session-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { ClaudeDispatchContentError } from '../claude/claude-structured-dispatch-content'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/structured-agent-session-option-error'
import { applyPiRpcSessionOption } from './rpc-options'
import { PiRpcPromptError, preparePiRpcPrompt } from './rpc-prompt'
import type { PiRpcSession, PiRpcSessionDeps } from './rpc-session'

type DispatchInput = Parameters<StructuredAgentSessionAdapter['dispatch']>[0]

function exited(): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
      agentName: 'Pi',
      surface: 'rejection'
    })
  }
}

export async function dispatchPiRpcMessage(
  session: PiRpcSession,
  input: DispatchInput,
  logger: PiRpcSessionDeps['logger'],
  isCurrent: () => boolean
): Promise<AgentSessionDispatchOutcome> {
  let prompt
  try {
    prompt = await preparePiRpcPrompt(input.body)
  } catch (error) {
    logger.warn('Pi prompt could not be prepared', {
      scope: 'pi-prompt',
      sessionId: input.sessionId,
      error
    })
    return {
      state: 'rejected',
      ...agentSessionFailureWords(
        error instanceof PiRpcPromptError || error instanceof ClaudeDispatchContentError
          ? error.failure
          : agentSessionFailureFact('attachmentUnreadable'),
        { agentName: 'Pi', surface: 'rejection' }
      )
    }
  }
  input.signal?.throwIfAborted()
  if (!isCurrent() || session.connection.closed) {
    return exited()
  }
  input.onInputPreparation?.()
  const model = input.executionOptions?.model ?? session.initialOptions.model
  if (!input.executionOptions) {
    input.signal?.throwIfAborted()
    return session.submit(
      input.clientMessageId,
      input.requestedAt ?? Date.now(),
      { ...prompt },
      input.beforeDispatch
    )
  }
  for (const key of ['model', 'effort'] as const) {
    const value =
      input.executionOptions?.[key] ??
      (key === 'model' || model === session.initialOptions.model
        ? session.initialOptions[key]
        : undefined)
    if (value === undefined && session.optionProof.writes.has(key)) {
      throw new AgentSessionOptionRejectedError(
        new Error(`The default ${key} for this model is unknown`)
      )
    }
    if (value === undefined || session.optionProof.current.get(key) === value) {
      continue
    }
    try {
      await applyPiRpcSessionOption(
        session.connection,
        session.selected,
        key,
        value,
        { signal: input.signal },
        session.optionProof
      )
    } catch (error) {
      input.signal?.throwIfAborted()
      if (session.connection.closed) {
        return exited()
      }
      if (error instanceof JsonlRpcResponseError) {
        throw withProviderDiagnostic(
          new AgentSessionOptionRejectedError(error),
          providerDiagnostic(error.message, 'person')
        )
      }
      throw new AgentSessionOptionRejectedError(error)
    }
  }
  input.signal?.throwIfAborted()
  if (!isCurrent() || session.connection.closed) {
    return exited()
  }
  return session.submit(
    input.clientMessageId,
    input.requestedAt ?? Date.now(),
    { ...prompt },
    input.beforeDispatch
  )
}
