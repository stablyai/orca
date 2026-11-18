import { randomUUID } from 'node:crypto'
import {
  isSameExtensionNavigation,
  resolveBrowserExtensionRequestedUrl
} from '../../../../shared/browser/extensions/browser-extension-url'
import { allowPageUnload } from '../../guest-lifecycle/navigation/browser-guest-unload-policy'
import { recordBrowserSessionInput } from '../../guest-lifecycle/input/browser-guest-input-gesture'
import { openBrowserExtensionTab } from '../tabs-and-windows/browser-extension-tab-model'
import { setupGuestShortcutForwarding } from '../../guest-lifecycle/input/shortcuts/browser-guest-shortcut-forwarding'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { forwardGuestMousePress } from '../../guest-lifecycle/input/browser-guest-mouse-press'
import { startBrowserExtensionDocument } from '../tabs-and-windows/browser-extension-document-ids'
import {
  browserExtensionSidePanelUrl,
  closeBrowserExtensionSidePanel,
  findBrowserExtensionSidePanelByAttachToken,
  getBrowserExtensionSidePanelRecord,
  markBrowserExtensionSidePanelOpened
} from './browser-extension-side-panel-host'
import {
  getBrowserExtensionSidePanelGuestOwner,
  noteBrowserExtensionSidePanelAdmitted
} from './browser-extension-side-panel-guests'

const ATTACH_MARKER = 'data:text/html,orca-side-panel-attach-'

/** The renderer asks for a webview src; main hands out a one-use marker it alone can redeem. */
export function prepareBrowserExtensionSidePanelAttach(panelId: string): string | null {
  const panel = getBrowserExtensionSidePanelRecord(panelId)
  if (!panel || (panel.guest && !panel.guest.isDestroyed())) {
    return null
  }
  panel.attachToken = randomUUID()
  return ATTACH_MARKER + panel.attachToken
}

export function isBrowserExtensionSidePanelAttachMarker(src: string): boolean {
  return src.startsWith(ATTACH_MARKER)
}

/** will-attach-webview: the marker must be this panel's live token in its profile's partition. */
export function admitBrowserExtensionSidePanelAttach(
  src: string,
  rendererId: number,
  partition: string
): boolean {
  const token = src.slice(ATTACH_MARKER.length)
  const panel = token ? findBrowserExtensionSidePanelByAttachToken(token) : null
  if (!panel || panel.partition !== partition) {
    return false
  }
  panel.attachToken = null
  noteBrowserExtensionSidePanelAdmitted(
    { panelId: panel.id, profileId: panel.profileId, extensionId: panel.extensionId },
    rendererId
  )
  return true
}

/** did-attach-webview: a claimed guest gets the popup's link and navigation policy, then its page. */
export function startBrowserExtensionSidePanelGuest(guest: Electron.WebContents): boolean {
  const owner = getBrowserExtensionSidePanelGuestOwner(guest)
  if (!owner) {
    return false
  }
  const panel = getBrowserExtensionSidePanelRecord(owner.panelId)
  // Why still claimed: a panel closed while attaching stays blank until the renderer drops it.
  if (!panel || panel.guest) {
    return true
  }
  panel.guest = guest
  recordBrowserSessionInput(guest)
  // Why as the page beside it: a focused panel swallows keys and its clicks never reach the host
  // DOM, so Orca's shortcuts (Mod+L, close tab) and split focus act for that page, as in Chrome.
  // Extension commands are observed with every extension view (browser-extension-startup).
  const host = guest.hostWebContents
  const resolveHost = (): Electron.WebContents | null => (host && !host.isDestroyed() ? host : null)
  const besidePage = (): string | null => panel.besidePageId
  const stopShortcuts = setupGuestShortcutForwarding({
    browserTabId: besidePage,
    guest,
    resolveRenderer: resolveHost,
    getKeybindings: () => browserManager.getKeybindingOverrides(),
    resolveWorktreeId: (pageId) => browserManager.getWorktreeIdForTab(pageId) ?? null,
    resolveWorkspaceId: (pageId) => browserManager.getWorkspaceIdForPage(pageId)
  })
  guest.once('destroyed', stopShortcuts)
  guest.on('before-mouse-event', (_event, mouse) => {
    const pageId = besidePage()
    // Presses only: a side button released in the panel must not move the page's history.
    if (mouse.type === 'mouseDown' && pageId) {
      forwardGuestMousePress(guest, pageId, resolveHost, mouse)
    }
  })
  guest.on('will-prevent-unload', allowPageUnload)
  guest.setWindowOpenHandler(({ url }) => {
    const resolved = resolveBrowserExtensionRequestedUrl(url, panel.extensionId)
    if (resolved && (resolved.kind !== 'extension' || resolved.extensionId === panel.extensionId)) {
      void openBrowserExtensionTab(panel.profileId, resolved.url, { active: true }).catch(() => {})
    }
    return { action: 'deny' }
  })
  guest.on('will-navigate', (event, target) => {
    if (!isSameExtensionNavigation(guest.getURL(), target)) {
      event.preventDefault()
    }
  })
  // Why: webNavigation skips panels, so nothing else starts a new documentId for getContexts.
  guest.on('did-navigate', () => startBrowserExtensionDocument(guest.mainFrame))
  guest.on('did-finish-load', () => {
    if (panel.guest === guest) {
      markBrowserExtensionSidePanelOpened(panel)
    }
  })
  guest.once('destroyed', () => {
    // Why close: the renderer removed the webview (its workspace closed or the window reloaded).
    if (panel.guest === guest) {
      panel.guest = null
      closeBrowserExtensionSidePanel(panel)
    }
  })
  guest.loadURL(browserExtensionSidePanelUrl(panel)).catch(() => {})
  return true
}
