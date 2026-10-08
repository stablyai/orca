// The CLI's own statement that a turn is over.
//
// `session_state_changed` carries `idle | running | requires_action`, and the SDK
// documents `idle` as firing once the held-back result has flushed and the
// background-agent loop has exited — the authoritative turn-over signal. It is
// the only end some turns get: a fault that stops a turn without a result frame
// leaves the running lifecycle row latched, and the chat reads working for the
// life of the session.
//
// `requires_action` is deliberately NOT an end. The turn is parked on the user,
// and a pending approval or question already projects as attention; settling
// here would read as idle in the gap before that row lands.

import { claudeText } from './claude-structured-item-translation'

function isClaudeSessionStateFrame(message: Record<string, unknown>): boolean {
  return message.type === 'system' && message.subtype === 'session_state_changed'
}

/** Whether this frame reports the CLI has no work in flight. */
export function claudeSessionStateEndsTurn(message: Record<string, unknown>): boolean {
  return isClaudeSessionStateFrame(message) && claudeText(message.state) === 'idle'
}
