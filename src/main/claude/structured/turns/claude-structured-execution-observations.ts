import {
  claudeObservedEffort,
  claudeShownFallbackModel
} from '../launch/claude-structured-session-options'
import type { ClaudeSession } from '../claude-structured-session-state'

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
function observeClaudeExecutionModel(
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

/** A session-scope refusal fallback swaps Claude's session model; a local one (subagent, /btw) does not. */
function observeClaudeModelFallback(
  session: ClaudeSession | null,
  frame: Record<string, unknown>
): boolean {
  const swap =
    frame.type === 'system' && frame.subtype === 'model_refusal_fallback' && frame.scope !== 'local'
      ? { model: frame.fallback_model, replaced: frame.original_model }
      : null
  if (
    !session ||
    typeof swap?.model !== 'string' ||
    typeof swap.replaced !== 'string' ||
    session.modelFallback?.model === swap.model
  ) {
    return false
  }
  // The input Orca sends, which may be an alias of the resolved id Claude names.
  const replaced = session.appliedInputOptions.get('model') ?? swap.replaced
  session.modelFallback = { model: swap.model, replaced }
  return true
}

/** Each model report restates the fallback, so a model write's clear reaches the status too. */
export function observeClaudeFrameModels(
  session: ClaudeSession | null,
  frame: Record<string, unknown>,
  initModel: string | null | undefined
): { model?: string; fallbackModel: string | undefined } | null {
  const execution = observeClaudeExecutionModel(session, initModel)
  const fallbackChanged = observeClaudeModelFallback(session, frame)
  return session && (execution || fallbackChanged)
    ? { ...execution, fallbackModel: claudeShownFallbackModel(session) }
    : null
}
