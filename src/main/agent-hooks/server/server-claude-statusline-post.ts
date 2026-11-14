import {
  parseClaudeStatusLineBody,
  parseClaudeStatusLineSessionWindow
} from '../../../shared/claude-statusline-rate-limits'
import { noteClaudeSessionWindow } from '../../native-chat/claude-session-window-store'
import type { ServerStatusLineListener } from './server-types'

/** One statusline post carries both the account's rate limits and this session's window. */
export function receiveClaudeStatusLinePost(
  body: unknown,
  listener: ServerStatusLineListener
): void {
  const sessionWindow = parseClaudeStatusLineSessionWindow(body)
  if (sessionWindow) {
    noteClaudeSessionWindow(sessionWindow.sessionId, sessionWindow.windowTokens)
  }
  const statusLineEvent = parseClaudeStatusLineBody(body)
  if (statusLineEvent) {
    listener?.(statusLineEvent)
  }
}
