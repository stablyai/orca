import { claudeObservedEffort } from '../launch/claude-structured-session-options'
import { readClaudeMessageEnvelope } from '../journal/claude-structured-item-translation'
import { isRootClaudeFrame } from './claude-turn-opening'
import { readClaudeModelFallback } from '../../../../shared/native-chat/transcript/notices/claude-model-fallback'
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
    delete session.modelFallback
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

/** Claude keeps the session on a main-thread refusal fallback; subagent fallbacks stay local. */
function observeClaudeModelFallback(
  session: ClaudeSession | null,
  frame: Record<string, unknown>
): boolean {
  const envelope = session && isRootClaudeFrame(frame) ? readClaudeMessageEnvelope(frame) : null
  const fallback =
    envelope?.role === 'assistant'
      ? envelope.content.map(readClaudeModelFallback).findLast((entry) => entry !== null)
      : undefined
  if (!session || !fallback || session.modelFallback?.model === fallback.to) {
    return false
  }
  const requested = session.appliedInputOptions.get('model')
  session.modelFallback = { model: fallback.to, ...(requested ? { requested } : {}) }
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
    ? { ...execution, fallbackModel: session.modelFallback?.model }
    : null
}
