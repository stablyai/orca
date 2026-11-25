import type { AgentBrowserBridge } from '../../../browser/agent-browser/agent-browser-bridge'
import { liveBrowserGuest } from '../../../browser/guest-lifecycle/live-browser-guest'

export function hasLiveRegisteredBrowserTab(
  bridge: AgentBrowserBridge,
  worktreeId: string | undefined
): boolean {
  for (const [, webContentsId] of bridge.getRegisteredTabs(worktreeId)) {
    if (liveBrowserGuest(webContentsId)) {
      return true
    }
  }
  return false
}

export function hasLiveRegisteredBrowserPage(
  bridge: AgentBrowserBridge,
  worktreeId: string | undefined,
  browserPageId: string
): boolean {
  const webContentsId = bridge.getRegisteredPageWebContentsId(browserPageId, worktreeId)
  if (webContentsId == null) {
    return false
  }
  return liveBrowserGuest(webContentsId) !== null
}
