// A chat's saved model is passed to the CLI as `--model` unchecked, so one the provider has since
// retired fails the turn. The CLI says so itself: a synthetic reply whose `error` is
// `model_not_found` (Claude Code 2.1.280). That reply is the evidence the saved model cannot run.

import { beginClaudeInputWrite, finishClaudeInputWrite } from './claude-structured-options'
import type {
  ClaudeSession,
  ClaudeStructuredSessionAdapterDeps
} from './structured/claude-structured-session-state'

/** Retire only a still-selected launch model after a root model_not_found reply; preserve saved picks. */
export function retireClaudeLaunchedModel(
  session: Pick<ClaudeSession, 'launchedModel' | 'options' | 'retiredModel'>,
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
  session.retiredModel = launched
  return launched
}

/** Reset to the CLI account default, ignoring env/settings model; newer picks outrank reset bookkeeping. */
export function resetClaudeRetiredModel(
  session: ClaudeSession,
  deps: Pick<ClaudeStructuredSessionAdapterDeps, 'requestTimeoutMs' | 'logger'>,
  sessionId: string,
  retired: string
): void {
  const sequence = beginClaudeInputWrite(session, 'model')
  void session.connection
    .setModel(undefined, { timeoutMs: deps.requestTimeoutMs })
    .then(
      () => {
        if (sequence !== session.optionMutationSequence) {
          return
        }
        if (session.fastModeDisabledMutation !== sequence) {
          delete session.fastModeDisabledReason
          delete session.fastModeDisabledMutation
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
    .finally(() => finishClaudeInputWrite(session, sequence))
}
