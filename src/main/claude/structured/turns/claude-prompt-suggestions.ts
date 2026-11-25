import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'
import type { ClaudeOpenTurn } from './claude-open-turn'

// Claude's guesses are a short sentence; a longer one is not worth a frame to every reader.
const CLAUDE_PROMPT_SUGGESTION_MAX_LENGTH = 1000

/** Takes the CLI's guess at the next prompt off the journal path, so no turn, context or activity
 *  logic sees it. It arrives after `result`; a turn or a send started since then makes it stale. */
export function withClaudePromptSuggestions(
  turn: Pick<ClaudeOpenTurn, 'isOpen'>,
  sink: Pick<StructuredAgentSessionEventSink, 'setPromptSuggestion'>,
  handle: (event: ClaudeStructuredSessionEvent) => void
): (event: ClaudeStructuredSessionEvent) => void {
  return (event) => {
    if (event.type !== 'message' || event.message.type !== 'prompt_suggestion') {
      handle(event)
      return
    }
    const { suggestion, uuid } = event.message
    const text = typeof suggestion === 'string' ? suggestion.trim() : ''
    if (
      !turn.isOpen &&
      !event.startedSend &&
      typeof uuid === 'string' &&
      text &&
      text.length <= CLAUDE_PROMPT_SUGGESTION_MAX_LENGTH
    ) {
      sink.setPromptSuggestion?.({ id: uuid, text })
    }
  }
}
