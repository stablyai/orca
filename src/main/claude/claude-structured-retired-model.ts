// A chat's saved model is passed to the CLI as `--model` unchecked, so one the provider has since
// retired fails the turn. The CLI says so itself: a synthetic reply whose `error` is
// `model_not_found` (Claude Code 2.1.280). That reply is the evidence the saved model cannot run.

import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './claude-structured-session-state'

/** The launched model, once, when a root reply says it does not exist and the chat still has it
 *  picked: the session stops holding it, so the record drops it. Null otherwise. */
export function retireClaudeLaunchedModel(
  session: Pick<ClaudeSession, 'launchedModel' | 'options' | 'restoreSkippedOptions'>,
  message: Record<string, unknown>
): string | null {
  const launched = session.launchedModel
  if (
    launched === null ||
    message.type !== 'assistant' ||
    (message.parent_tool_use_id ?? null) !== null ||
    message.error !== 'model_not_found' ||
    session.options.get('model') !== launched
  ) {
    return null
  }
  session.options.delete('model')
  session.restoreSkippedOptions.add('model')
  return launched
}

/** Moves the live child to the CLI's account default (`set_model` with no model), which unlike a
 *  fresh launch ignores ANTHROPIC_MODEL and a settings `model`. A user's pick made meanwhile owns
 *  the model; a refused or unanswered reset changes nothing but the log. */
export function resetClaudeRetiredModel(
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>,
  sessionId: string,
  retired: string
): void {
  const sequence = session.optionMutationSequence
  void session.connection.setModel(undefined, { timeoutMs: deps.requestTimeoutMs }).then(
    () => {
      if (sequence !== session.optionMutationSequence) {
        return
      }
      // The retired id is no longer what runs; the next turn's own report names the default.
      if (session.reportedOptions.model === retired) {
        delete session.reportedOptions.model
      }
      if (session.appliedOptions?.model === retired) {
        const { model: _retired, ...applied } = session.appliedOptions
        session.appliedOptions = applied
      }
    },
    (error: unknown) =>
      deps.logger?.warn('putting a retired Claude model back on the default failed', {
        scope: 'claude-retired-model-reset',
        sessionId,
        error
      })
  )
}

/** The saved values this child showed it cannot run. Only a retired launch model is one: a launch
 *  never skips a model, so a skipped model is that. */
export function claudeRetiredOptions(
  session: Pick<ClaudeSession, 'launchedModel' | 'restoreSkippedOptions'>
): { retiredOptions?: Record<string, string> } {
  return session.restoreSkippedOptions.has('model') && session.launchedModel !== null
    ? { retiredOptions: { model: session.launchedModel } }
    : {}
}
