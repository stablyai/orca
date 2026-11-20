import { randomUUID } from 'node:crypto'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'

/** Asks the renderer, which owns Orca's tab model, to make one browser page the active tab. */
export async function activateBrowserTabInRenderer(
  windowId: number,
  browserPageId: string
): Promise<void> {
  const requestId = randomUUID()
  const reply = await getRuntimeDesktopSurface().requestRenderer<{
    requestId: string
    error?: string
  }>(windowId, {
    requestId,
    channel: 'browser:requestTabActivate',
    replyChannel: 'browser:tabActivateReply',
    payload: { requestId, browserPageId },
    timeoutMs: 10_000,
    timeoutMessage: 'Tab activation timed out'
  })
  if (reply.error) {
    throw new Error(reply.error)
  }
}
