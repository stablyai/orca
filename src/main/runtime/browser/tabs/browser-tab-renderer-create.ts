import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { captureActiveRpcCall } from '../../rpc/callers/active-call'
import { retainBrowserMemoryPageForAgent } from '../../../browser/guest-lifecycle/browser-page-memory'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'
import type { BrowserTabSplitDirection } from '../../../../shared/browser/workspaces/browser-tab-split-direction'
import type { BrowserTabCreateRequest } from '../../../../shared/browser/workspaces/browser-tab-create-request'

export async function createBrowserTabInRenderer(
  host: Pick<RuntimeBrowserCommandHost, 'getAuthoritativeWindowId'>,
  url: string,
  worktreeId: string | undefined,
  profileId: string | undefined,
  sessionPartition: string | undefined,
  activate?: boolean,
  requestedPageId?: string,
  /** Used only when `worktreeId` is unset and no workspace is active in the renderer. */
  fallbackWorktreeId?: string,
  split?: { direction: BrowserTabSplitDirection; fromTabId?: string }
): Promise<{ browserPageId: string }> {
  const windowId = host.getAuthoritativeWindowId()
  const desktop = getRuntimeDesktopSurface()
  const withCaller = captureActiveRpcCall()
  const request: Omit<BrowserTabCreateRequest, 'requestId'> = {
    url,
    worktreeId,
    ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
    // undefined preserves renderer default-profile inheritance; null would override it.
    sessionProfileId: profileId,
    sessionPartition,
    activate,
    ...(fallbackWorktreeId ? { fallbackWorktreeId } : {}),
    ...(split ? { split: split.direction, splitFromTabId: split.fromTabId } : {})
  }
  const reply = await desktop.requestRenderer<{
    requestId: string
    browserPageId?: string
    error?: string
  }>(windowId, {
    channel: 'browser:requestTabCreate',
    replyChannel: 'browser:tabCreateReply',
    payload: request,
    timeoutMs: 10_000,
    timeoutMessage: 'Tab creation timed out'
  })
  if (reply.error) {
    throw new Error(reply.error)
  }
  const browserPageId = reply.browserPageId!
  withCaller(() =>
    retainBrowserMemoryPageForAgent(browserPageId, desktop.rendererIdOfWindow?.(windowId) ?? null)
  )

  return { browserPageId }
}
