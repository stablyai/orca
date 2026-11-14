import type { BrowserWindow } from 'electron'

import type {
  SessionTabScrollReply,
  SessionTabScrollTarget
} from '../../../shared/workspace-layout/session-tab-scroll'
import { requestRendererReply } from './renderer-reply-request'

const SESSION_TAB_SCROLL_TIMEOUT_MS = 5_000

/** Scrolls a tab the window shows without raising the window; resolves false when it is not on screen. */
export async function scrollSessionTabInWindow(
  mainWindow: BrowserWindow,
  target: SessionTabScrollTarget
): Promise<boolean> {
  const reply = await requestRendererReply<SessionTabScrollReply>(mainWindow, {
    requestChannel: 'ui:scrollSessionTab',
    replyChannel: 'ui:sessionTabScrollReply',
    payload: target,
    timeoutMs: SESSION_TAB_SCROLL_TIMEOUT_MS,
    timeoutError: 'session_tab_scroll_timeout'
  })
  return reply.scrolled === true
}
