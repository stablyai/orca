import { TERMINAL_EMPTY_DRAFT_RESERVATION_CAPABILITY } from '../../../../src/shared/terminal/runtime-policy/terminal-runtime-capabilities'

export function notificationReplyTerminalClient(): { id: 'orca-cli'; type: 'desktop' } {
  return { id: 'orca-cli', type: 'desktop' }
}

export function assertNotificationReplyTerminalSupport(
  capabilities: readonly string[] | undefined
): void {
  if (!capabilities?.includes(TERMINAL_EMPTY_DRAFT_RESERVATION_CAPABILITY)) {
    throw new Error('This host does not support safe notification replies')
  }
}
