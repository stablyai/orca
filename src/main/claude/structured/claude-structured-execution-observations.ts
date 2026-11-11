import { claudeObservedEffort } from './launch/claude-structured-session-options'
import { claudeRecord, claudeText } from './journal/claude-structured-item-translation'
import { isRootClaudeFrame } from '../claude-turn-opening'
import { MAX_CONTEXT_MODEL_ID_CHARS } from '../../../shared/agent-session/agent-session-context-usage'
import type { ClaudeSession } from './claude-structured-session-state'

/** Fast routing reports precede this input and cannot vouch for its execution. */
export function claudeExecutionObservations(session: ClaudeSession): Record<string, string> {
  const model =
    session.reportedModelMutation === session.optionMutationSequence
      ? (session.reportedOptions.model ?? session.appliedOptions?.model)
      : session.appliedOptions?.model
  const effort = claudeObservedEffort(
    session.appliedOptions?.effort,
    session.appliedOptions?.ultracode
  )
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
}

/** Retire affected evidence before a control can change the child, even if its answer is lost. */
export function beginClaudeOptionMutation(session: ClaudeSession, key: string): number {
  const previous = session.optionMutationSequence++
  const sequence = session.optionMutationSequence
  if (key === 'model') {
    delete session.appliedOptions
  } else {
    if (session.reportedModelMutation === previous) {
      session.reportedModelMutation = sequence
    }
    if (key === 'effort' && session.appliedOptions) {
      const { effort: _old, ...applied } = session.appliedOptions
      session.appliedOptions = applied
    }
  }
  return sequence
}

/** An init names execution; a control answer only acknowledges its input. */
export function observeClaudeExecutionModel(
  session: ClaudeSession | null,
  model: string | null | undefined
): { model: string } | null {
  if (!session || !model) {
    return null
  }
  const previous = claudeExecutionObservations(session).model
  if (previous !== model) {
    delete session.appliedOptions
  }
  session.reportedOptions.model = model
  session.reportedModelMutation = session.optionMutationSequence
  return previous !== model ? { model } : null
}

/** Main-thread response metadata names the model that answered, including provider fallback. */
export function readClaudeResponseModel(frame: Record<string, unknown>): string | null {
  if (!isRootClaudeFrame(frame)) {
    return null
  }
  const event = claudeRecord(frame.event)
  const message =
    frame.type === 'assistant'
      ? claudeRecord(frame.message)
      : frame.type === 'stream_event' && event?.type === 'message_start'
        ? claudeRecord(event.message)
        : null
  const model = message?.role === 'assistant' ? claudeText(message.model)?.trim() : null
  return model && model !== '<synthetic>' && model.length <= MAX_CONTEXT_MODEL_ID_CHARS
    ? model
    : null
}
