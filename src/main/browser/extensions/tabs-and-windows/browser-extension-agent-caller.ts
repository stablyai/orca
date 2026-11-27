import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { getLastBrowserGuestInputInSession } from '../../guest-lifecycle/input/browser-guest-input-gesture'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'
import {
  BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS,
  getBrowserExtensionUserGestureAt
} from '../permissions/browser-extension-user-gesture'
import type { openBrowserExtensionTab } from './browser-extension-tab-model'

export type BrowserExtensionTabPlacement = Parameters<typeof openBrowserExtensionTab>[2]

type AgentPage = { worktreeId: string | null }

function pageOfGuest(guestWebContentsId: number): AgentPage {
  const tabId = browserManager.getOwningTabIdForGuestWebContentsId(guestWebContentsId)
  return { worktreeId: (tabId && browserManager.getWorktreeIdForTab(tabId)) ?? null }
}

/**
 * The agent's page this call acts for, or null when the user set it off. An extension reacts to
 * its profile's pages (a wallet popup, an OAuth tab) without saying which input started it, so
 * the newest recent click, key or Orca-delivered gesture decides, then whether an agent leads.
 */
export function findBrowserExtensionCallerAgentPage(
  caller: BrowserExtensionCaller
): AgentPage | null {
  const now = Date.now()
  const lastInput = getLastBrowserGuestInputInSession(caller.session)
  const input =
    lastInput && now - lastInput.at <= BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS ? lastInput : null
  const gestureAt = getBrowserExtensionUserGestureAt(caller)
  if (gestureAt !== null && (!input || gestureAt >= input.at)) {
    return null
  }
  if (input) {
    // Agents and remote viewers send injected input; only the desktop user's own may surface.
    return input.byAgent ? pageOfGuest(input.guestWebContentsId) : null
  }
  // Why before userGesture: an agent's click on an extension page also activates that page.
  if (caller.webContents && browserManager.isAgentLeadingGuest(caller.webContents.id)) {
    return pageOfGuest(caller.webContents.id)
  }
  return caller.userGesture ? null : browserManager.findAgentPageInSession(caller.session)
}

/** An agent's extension tab opens in the background beside its page, never in the user's view. */
export function placeBrowserExtensionCallerTab(
  caller: BrowserExtensionCaller,
  active: boolean
): BrowserExtensionTabPlacement {
  const agentPage = findBrowserExtensionCallerAgentPage(caller)
  if (!agentPage) {
    return { active }
  }
  return { active: false, ...(agentPage.worktreeId ? { worktreeId: agentPage.worktreeId } : {}) }
}
