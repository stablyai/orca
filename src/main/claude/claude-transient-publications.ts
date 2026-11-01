import { claudeProviderFrameActivity } from '../native-chat/agent-session-wire/provider-frame-activity'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeOpenTurn } from './claude-open-turn'
import { claudeRecord, claudeText } from './structured/journal/claude-structured-item-translation'

/** Frame-only publications: the open turn's activity, and the prompt Claude predicts after it. */
export class ClaudeTransientPublications {
  // A relaunch may inherit a suggestion the host still retains, so its first turn clears too.
  private suggesting = true

  constructor(
    private readonly sink: Pick<
      StructuredAgentSessionEventSink,
      'setActivity' | 'setPromptSuggestion'
    >,
    private readonly turn: Pick<ClaudeOpenTurn, 'id' | 'sendUnechoed'>
  ) {}

  observe(kind: string, payload: unknown): void {
    const turnId = this.turn.id
    if (kind === 'message:prompt_suggestion') {
      const suggestion = claudeText(claudeRecord(payload)?.suggestion)?.trim()
      // Arrives after the result; a send since then makes it stale.
      if (turnId === null && !this.turn.sendUnechoed && suggestion) {
        this.suggesting = true
        this.sink.setPromptSuggestion?.(suggestion)
      }
      return
    }
    if (turnId === null) {
      return
    }
    const text = claudeProviderFrameActivity(kind, payload)
    if (text !== undefined) {
      this.sink.setActivity?.(text ? { turnId, text } : null)
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
