import type { ClaudeSession, ClaudeStructuredSessionEvent } from './claude-structured-session-state'

export function clearClaudePromptSuggestion(session: ClaudeSession): void {
  session.promptSuggestionResultSequence = undefined
  if (session.promptSuggestion) {
    session.promptSuggestion = null
    session.events?.publish()
  }
}

export function observeClaudePromptSuggestion(
  session: ClaudeSession,
  event: ClaudeStructuredSessionEvent
): void {
  if (event.type === 'ended') {
    clearClaudePromptSuggestion(session)
    return
  }
  if (event.type !== 'message') {
    return
  }
  const { message } = event
  if (event.startsTurn || message.type === 'assistant') {
    clearClaudePromptSuggestion(session)
  } else if (message.type === 'result') {
    clearClaudePromptSuggestion(session)
    session.promptSuggestionResultSequence =
      message.is_error !== true && session.dispatchWaiters.length === 0
        ? session.dispatchSequence
        : undefined
  } else if (
    message.type === 'prompt_suggestion' &&
    session.promptSuggestionResultSequence === session.dispatchSequence &&
    session.dispatchWaiters.length === 0 &&
    typeof message.suggestion === 'string' &&
    message.suggestion.trim() &&
    message.suggestion.length <= 4096 &&
    message.suggestion !== session.promptSuggestion
  ) {
    session.promptSuggestion = message.suggestion
    session.events?.publish()
  }
}
