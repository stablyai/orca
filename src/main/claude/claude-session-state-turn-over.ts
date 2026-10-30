// Idle ends turns even when results are missing; requires_action stays open for pending user input.

import { claudeText } from './claude-structured-item-translation'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'

function isClaudeSessionStateFrame(message: Record<string, unknown>): boolean {
  return message.type === 'system' && message.subtype === 'session_state_changed'
}

export function claudeSessionStateEndsTurn(message: Record<string, unknown>): boolean {
  return isClaudeSessionStateFrame(message) && claudeText(message.state) === 'idle'
}

export function idleClaudeJournalTurn(
  translator: ClaudeJournalTranslator,
  sessionId: string,
  providerSessionId: string,
  observedAt?: number
): void {
  translator.handle({
    type: 'message',
    sessionId,
    message: {
      type: 'system',
      subtype: 'session_state_changed',
      state: 'idle',
      session_id: providerSessionId
    },
    ...(observedAt === undefined ? {} : { observedAt })
  })
}
