import type { ScheduledMessageFailureReason } from '../shared/scheduled-message-types'
import { getTerminalSendGuardRefusedReason } from './runtime/rpc/terminal-agent-send-guard'

/** A permission prompt is not a failure, but a prompt nobody ever answers still
 *  has to end. */
export const MAX_DELIVERY_ATTEMPTS = 3

export type ScheduledMessageDeliveryOutcome =
  /** `spendsAttempt` is false for a refusal that says nothing about whether the
   *  message can ever be delivered. */
  | { kind: 'retry'; spendsAttempt: boolean }
  | { kind: 'fail'; reason: ScheduledMessageFailureReason; loud: boolean }

/** Maps a send-guard rejection to what happens to the message. */
export function resolveScheduledMessageDeliveryOutcome(
  error: unknown,
  attemptsSoFar: number
): ScheduledMessageDeliveryOutcome {
  switch (getTerminalSendGuardRefusedReason(error)) {
    case 'permission':
      return attemptsSoFar + 1 < MAX_DELIVERY_ATTEMPTS
        ? { kind: 'retry', spendsAttempt: true }
        : { kind: 'fail', reason: 'send-failed', loud: false }
    // The agent took work back up between the idle check and the write; the next
    // idle edge arms it again.
    case 'agent-busy':
      return { kind: 'retry', spendsAttempt: false }
    // The guard proved no agent is running. Expected enough not to warrant a
    // console warning — the workspace simply isn't in a state to receive text.
    case 'no-agent':
      return { kind: 'fail', reason: 'no-agent', loud: false }
    // Not a guard refusal at all — the PTY write itself failed. Worth a warning
    // because nothing else in the system explains it.
    case undefined:
      return { kind: 'fail', reason: 'send-failed', loud: true }
  }
}
