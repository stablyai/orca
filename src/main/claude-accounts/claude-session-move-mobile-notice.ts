import { formatClaudeSessionMoveList } from '../../shared/claude-session-move-line'
import type { MobileNotificationDispatchEvent } from '../runtime/push/notifications/runtime-mobile-notification-controller'
import type { ClaudeSessionMoveNotice } from './claude-session-mover-types'

/** One stream item per update, so a burst of panes does not stack a banner per row. */
export const CLAUDE_RECENT_MOVES_ATTENTION_KEY = 'claude-recent-moves'

/** The phone's notification stream gets the same rows as `orca account moves`. */
export function claudeRecentMovesMobileNotification(
  notice: ClaudeSessionMoveNotice,
  title: string
): MobileNotificationDispatchEvent | null {
  const moves = notice.moves ?? []
  if (moves.length === 0) {
    return null
  }
  return {
    type: 'notification',
    source: 'plugin',
    title,
    body: formatClaudeSessionMoveList(moves),
    attentionKey: CLAUDE_RECENT_MOVES_ATTENTION_KEY,
    ...(notice.paneKey ? { paneKey: notice.paneKey } : {})
  }
}

export function dispatchClaudeRecentMoves(
  dispatch: ((event: MobileNotificationDispatchEvent) => void) | null | undefined,
  notice: ClaudeSessionMoveNotice,
  title: string
): void {
  const event = claudeRecentMovesMobileNotification(notice, title)
  if (!event || !dispatch) {
    return
  }
  dispatch(event)
}
