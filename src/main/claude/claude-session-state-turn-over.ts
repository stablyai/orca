// Idle ends turns even when results are missing; requires_action stays open for pending user input.

import { claudeText } from './claude-structured-item-translation'

function isClaudeSessionStateFrame(message: Record<string, unknown>): boolean {
  return message.type === 'system' && message.subtype === 'session_state_changed'
}

export function claudeSessionStateEndsTurn(message: Record<string, unknown>): boolean {
  return isClaudeSessionStateFrame(message) && claudeText(message.state) === 'idle'
}
