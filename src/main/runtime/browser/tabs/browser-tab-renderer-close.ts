import { BrowserError } from '../../../browser/browser-error'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

/** Asks the renderer, which owns Orca's tab model, to close one browser page. */
export async function closeBrowserTabInRenderer(
  windowId: number,
  tabId: string | null,
  worktreeId: string | undefined
): Promise<void> {
  const reply = await getRuntimeDesktopSurface().requestRenderer<{
    requestId: string
    error?: string
    code?: 'browser_tab_not_found'
  }>(windowId, {
    channel: 'browser:requestTabClose',
    replyChannel: 'browser:tabCloseReply',
    // Why: pass worktreeId so the renderer scopes the close correctly instead of falling back to the globally active tab in the wrong worktree.
    payload: { tabId, worktreeId },
    timeoutMs: 10_000,
    timeoutMessage: 'Tab close timed out'
  })
  if (reply.error) {
    throw reply.code === 'browser_tab_not_found'
      ? new BrowserError('browser_tab_not_found', reply.error)
      : new Error(reply.error)
  }
}
