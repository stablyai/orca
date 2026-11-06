import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './structured/journal/claude-structured-item-translation'

/** The prompt Claude predicts after a turn, published off the journal. */
export class ClaudePromptSuggestions {
  // A relaunch may inherit a suggestion the host still retains, so its first turn clears too.
  private suggesting = true

  constructor(
    private readonly sink: Pick<StructuredAgentSessionEventSink, 'setPromptSuggestion'>,
    private readonly turn: Pick<ClaudeOpenTurn, 'id' | 'sendUnechoed'>
  ) {}

  observe(kind: string, payload: unknown): void {
    if (kind !== 'message:prompt_suggestion') {
      return
    }
    const suggestion = claudeText(claudeRecord(payload)?.suggestion)?.trim()
    // Arrives after the result; a send since then makes it stale.
    if (this.turn.id === null && !this.turn.sendUnechoed && suggestion) {
      this.suggesting = true
      this.sink.setPromptSuggestion?.(suggestion)
    }
  }

  /** Clears only a published suggestion, so turns without one publish nothing. */
  turnOpened(): void {
    if (this.suggesting) {
      this.suggesting = false
      this.sink.setPromptSuggestion?.(null)
    }
  }
}
