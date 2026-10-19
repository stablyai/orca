import type { ScheduledMessage } from '../shared/scheduled-message-types'
import type { ScheduledMessagePaneTarget } from './scheduled-message-service-contracts'

/** Oldest first: the queue is FIFO, and only one message goes per edge so each
 *  gets its own agent turn instead of being concatenated into one. */
export function pickNextIdleMessage(
  messages: ScheduledMessage[],
  worktreeId: string
): ScheduledMessage | undefined {
  return messages
    .filter(
      (message) =>
        message.worktreeId === worktreeId &&
        message.status === 'pending' &&
        message.timing.kind === 'when-idle'
    )
    .sort((a, b) => a.createdAt - b.createdAt)[0]
}

/** Fails open: an unreadable status is not evidence the agent is busy, and refusing
 *  on it would strand the message until an edge that may never come. */
export async function confirmAgentStillIdle(
  isAgentIdle: ((pane: ScheduledMessagePaneTarget) => Promise<boolean>) | undefined,
  pane: ScheduledMessagePaneTarget,
  logger: Pick<Console, 'debug'>
): Promise<boolean> {
  if (!isAgentIdle) {
    return true
  }
  try {
    return await isAgentIdle(pane)
  } catch (error) {
    logger.debug('[scheduled-messages] idle re-check failed', { error })
    return true
  }
}

export class ScheduledMessageIdleTimers {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()

  has(messageId: string): boolean {
    return this.timers.has(messageId)
  }

  arm(messageId: string, settleMs: number, onSettled: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(messageId)
      onSettled()
    }, settleMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    this.timers.set(messageId, timer)
  }

  clear(messageId: string): void {
    const timer = this.timers.get(messageId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(messageId)
    }
  }

  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer)
    }
    this.timers.clear()
  }
}
