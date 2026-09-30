// What Claude's per-command `command_lifecycle` frames (msg_lifecycle_v1) settle.
//
// `cancelled` is not by itself a withdrawal: a command the CLI already started also ends
// `cancelled` when its turn is interrupted or fails (measured on 2.1.280). Only a command
// cancelled before it started was withdrawn. That frame lands ahead of the control answer, so
// it settles the send even when the interrupt or cancel_async_message answer is lost.

import { settleCancelledClaudeDispatchWaiters } from './claude-structured-dispatch'
import { readClaudeFrameString } from './claude-structured-init-proof'
import type { ClaudeLateDispatchSettlement } from './claude-replay-turn-resolution'
import type { ClaudeSession } from './claude-structured-session-state'

export function observeClaudeCommandLifecycle(
  session: ClaudeSession,
  message: Record<string, unknown>,
  onSettledLate?: ClaudeLateDispatchSettlement
): void {
  const commandUuid = readClaudeFrameString(message, 'command_uuid')
  // An echoed send has left both lists, so nothing here can reach a delivered message.
  const waiter = [...session.dispatchWaiters, ...session.retiredDispatchWaiters].find(
    (candidate) => candidate.sentUuid === commandUuid
  )
  if (!waiter) {
    return
  }
  const state = message.state
  if (state === 'started' || (state === 'queued' && waiter.commandLifecycle !== 'started')) {
    // Forward only: a redelivered command re-emits `queued`, but it has still started.
    waiter.commandLifecycle = state
  } else if (state === 'cancelled' && waiter.commandLifecycle !== 'started') {
    settleCancelledClaudeDispatchWaiters(session, [waiter.sentUuid], onSettledLate)
  }
}
