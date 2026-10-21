import type { ClaudeSession } from './claude-structured-session-state'

/** Provider observations only; requested choices and picker defaults cannot vouch for a run. */
export function claudeExecutionObservations(session: ClaudeSession): Record<string, string> {
  const model =
    session.reportedModelMutation === session.optionMutationSequence
      ? (session.reportedOptions.model ?? session.appliedOptions?.model)
      : session.appliedOptions?.model
  const effort = session.appliedOptions?.effort
  const fast =
    session.fastModeReportedMutation === session.optionMutationSequence &&
    session.fastModeState === 'on' &&
    session.reportedOptions.fastMode !== false
  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(fast ? { fastMode: 'true' } : {})
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
  if (key === 'model' || key === 'fastMode') {
    delete session.fastModeReportedMutation
  } else if (session.fastModeReportedMutation === previous) {
    session.fastModeReportedMutation = sequence
  }
  return sequence
}

/** An init names the model that runs; a control answer only acknowledges its input. */
export function observeClaudeExecutionModel(session: ClaudeSession, model: string): boolean {
  const previous = claudeExecutionObservations(session).model
  if (previous !== model) {
    delete session.appliedOptions
  }
  session.reportedOptions.model = model
  session.reportedModelMutation = session.optionMutationSequence
  return previous !== model
}
