// The CLI's own statement that a turn is over.
//
// `session_state_changed` carries `idle | running | requires_action`, and the SDK
// documents `idle` as firing once the held-back result has flushed and the
// background-agent loop has exited — the authoritative turn-over signal. It is
// the only end some turns get: a fault that stops a turn without a result frame
// leaves the running lifecycle row latched, and the chat reads working for the
// life of the session.
//
// It is also what ends the sends handed to the CLI. A `result` ends one request cycle, and a send
// written during that cycle the CLI runs as its NEXT one: measured (2.1.280, p2-miss), the result
// arrives without it, the next init 28 ms later, its echo 3 s after that, and no idle in between.
// A CLI that never reports state gets its `result` as the turn-over, as its turns do.
//
// `requires_action` is deliberately NOT an end. The turn is parked on the user,
// and a pending approval or question already projects as attention; settling
// here would read as idle in the gap before that row lands.

import { claudeText } from './claude-structured-item-translation'

function isClaudeSessionStateFrame(message: Record<string, unknown>): boolean {
  return message.type === 'system' && message.subtype === 'session_state_changed'
}

/** Whether this frame is the CLI reporting its state at all. A CLI that reports it announces
 *  `running` before a cycle's first frame, so this is known before the first `result`. */
export function claudeReportsSessionState(message: Record<string, unknown>): boolean {
  return isClaudeSessionStateFrame(message)
}

/** Whether this frame reports the CLI has no work in flight. */
export function claudeSessionStateEndsTurn(message: Record<string, unknown>): boolean {
  return isClaudeSessionStateFrame(message) && claudeText(message.state) === 'idle'
}
