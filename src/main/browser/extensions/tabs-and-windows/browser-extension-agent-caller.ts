import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { getLastBrowserGuestInputInSession } from '../../guest-lifecycle/input/browser-guest-input-gesture'
import type { BrowserExtensionCaller } from '../api-runtime/browser-extension-namespace-registry'
import {
  BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS,
  hasBrowserExtensionUserGesture
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
 * the latest click or key in the profile decides, then whether an agent is driving a page there.
 */
export function findBrowserExtensionCallerAgentPage(
  caller: BrowserExtensionCaller
): AgentPage | null {
  // Why first: an agent's click on an extension page also counts as that page's user gesture.
  if (caller.webContents && browserManager.isAgentUsingGuest(caller.webContents.id)) {
    return pageOfGuest(caller.webContents.id)
  }
  if (hasBrowserExtensionUserGesture(caller)) {
    return null
  }
  const input = getLastBrowserGuestInputInSession(caller.session)
  if (input && Date.now() - input.at <= BROWSER_EXTENSION_USER_GESTURE_WINDOW_MS) {
    // Agents and remote viewers send injected input; only the desktop user's own may surface.
    return input.byAgent ? pageOfGuest(input.guestWebContentsId) : null
  }
  return browserManager.findAgentPageInSession(caller.session)
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
