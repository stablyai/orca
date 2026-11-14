import {
  agentSessionFailureFact,
  providerDiagnostic,
  withProviderDiagnostic
} from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'
import { ClaudeDispatchContentError } from '../../claude/structured/claude-structured-dispatch-content'
import { JsonlRpcResponseError } from '../../jsonl-rpc/peer-reply'
import type {
  AgentSessionDispatchOutcome,
  StructuredAgentSessionAdapter
} from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import { applyPiRpcSessionOption } from './options/rpc-options'
import { PiRpcPromptError, preparePiRpcPrompt, type PiRpcPrompt } from './prompts/rpc-prompt'
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
    prompt = await preparePiRpcPrompt(input.body, session.shrinksImages)
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
  // Pi refuses prompts during a requested compaction. Wait it out, then reapply this send's
  // options in case a pick changed them meanwhile, until none started during the option RPCs.
  do {
    await session.turns.compaction.waitForEnd(input.signal)
    for (const key of ['model', 'effort'] as const) {
      const value = input.executionOptions?.[key]
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
  } while (session.turns.compaction.running)
  input.signal?.throwIfAborted()
  if (!isCurrent() || session.connection.closed) {
    return exited()
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
