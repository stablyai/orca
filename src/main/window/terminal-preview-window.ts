import type { WebContents } from 'electron'
import { isDashboardPopoutRenderer } from './dashboard-popout-window'
import { isDetachedTerminalRenderer } from './detached-terminal-window'

/** The dashboard popout or a detached terminal window: both type into and copy from a terminal preview. */
export function isTerminalPreviewWindow(sender: WebContents): boolean {
  return isDashboardPopoutRenderer(sender) || isDetachedTerminalRenderer(sender)
}
