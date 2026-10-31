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
import { PiRpcPromptError, preparePiRpcPrompt, type PiRpcPrompt } from './rpc-prompt'
import type { PiRpcSession, PiRpcSessionDeps } from './rpc-session'

type DispatchInput = Parameters<StructuredAgentSessionAdapter['dispatch']>[0]

function exited(agentName: string): AgentSessionDispatchOutcome {
  return {
    state: 'rejected',
    ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
      agentName,
      surface: 'rejection'
    })
  }
}

export async function dispatchPiRpcMessage(
  session: PiRpcSession,
  input: DispatchInput,
  logger: PiRpcSessionDeps['logger'],
  isCurrent: () => boolean,
  optionWriter?: NonNullable<PiRpcSessionDeps['dialect']>['dispatchOptions']
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
        { agentName: session.agentName, surface: 'rejection' }
      )
    }
  }
  input.signal?.throwIfAborted()
  if (!isCurrent() || session.connection.closed) {
    return exited(session.agentName)
  }
  input.onInputPreparation?.()
  if (!input.executionOptions) {
    input.signal?.throwIfAborted()
    return submitPiRpcPrompt(session, input, prompt)
  }
  for (const key of optionWriter?.keys ?? ['model', 'effort']) {
    const value = input.executionOptions[key]
    if (
      value === undefined ||
      (!optionWriter?.alwaysWrite?.includes(key) && session.optionProof.current.get(key) === value)
    ) {
      continue
    }
    try {
      await (optionWriter
        ? optionWriter.write(session, key, value, input.signal)
        : applyPiRpcSessionOption(
            session.connection,
            session.selected,
            key,
            value,
            { signal: input.signal },
            session.optionProof
          ))
    } catch (error) {
      input.signal?.throwIfAborted()
      if (session.connection.closed) {
        return exited(session.agentName)
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
    return exited(session.agentName)
  }
  return submitPiRpcPrompt(session, input, prompt)
}

/** Pi runs the prompt on the model and effort it proved: its own state, never a stale report. */
async function submitPiRpcPrompt(
  session: PiRpcSession,
  input: DispatchInput,
  prompt: PiRpcPrompt
): Promise<AgentSessionDispatchOutcome> {
  let ranOptions: Record<string, string> = {}
  const outcome = await session.submit(
    input.clientMessageId,
    input.requestedAt ?? Date.now(),
    { ...prompt },
    async () => {
      await input.beforeDispatch?.()
      input.onExecutionSnapshot?.()
      ranOptions = Object.fromEntries(session.optionProof.current)
    }
  )
  return outcome.state === 'accepted' || outcome.state === 'admitted'
    ? { ...outcome, ranOptions }
    : outcome
}
