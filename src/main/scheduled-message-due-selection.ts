import type { ScheduledMessage } from '../shared/scheduled-message-types'

/** flatMap, not filter, so `sendAt` is narrowed out of the timing union for the
 *  caller, which measures lateness against it. */
export function pickDueMessages(
  messages: ScheduledMessage[],
  now: number
): { message: ScheduledMessage; sendAt: number }[] {
  return messages.flatMap((message) =>
    message.status === 'pending' && message.timing.kind === 'at' && message.timing.sendAt <= now
      ? [{ message, sendAt: message.timing.sendAt }]
      : []
  )
}
