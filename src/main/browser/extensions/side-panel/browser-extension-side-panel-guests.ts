/**
 * Which webview guests are extension side panels. Kept apart from the panel host so the tab model
 * can ask without importing it: a panel is an extension view, and tabs.*, webNavigation and
 * commands must never see it as a tab.
 */
export type BrowserExtensionSidePanelGuestOwner = {
  panelId: string
  profileId: string
  extensionId: string
}

const ownerByGuest = new WeakMap<Electron.WebContents, BrowserExtensionSidePanelGuestOwner>()
let admitted: { owner: BrowserExtensionSidePanelGuestOwner; rendererId: number } | null = null

/** will-attach-webview admitted a panel; Electron creates its guest synchronously afterwards. */
export function noteBrowserExtensionSidePanelAdmitted(
  owner: BrowserExtensionSidePanelGuestOwner,
  rendererId: number
): void {
  const pending = { owner, rendererId }
  admitted = pending
  queueMicrotask(() => {
    if (admitted === pending) {
      admitted = null
    }
  })
}

/** web-contents-created: claims the guest before any other observer treats it as a tab. */
export function associateBrowserExtensionSidePanelGuest(guest: Electron.WebContents): void {
  const pending = admitted
  if (
    !pending ||
    guest.getType() !== 'webview' ||
    guest.hostWebContents?.id !== pending.rendererId
  ) {
    return
  }
  admitted = null
  ownerByGuest.set(guest, pending.owner)
}

export function getBrowserExtensionSidePanelGuestOwner(
  contents: Electron.WebContents
): BrowserExtensionSidePanelGuestOwner | null {
  return ownerByGuest.get(contents) ?? null
}

export function isBrowserExtensionSidePanelGuest(contents: Electron.WebContents): boolean {
  // Why the pending check: web-contents-created observers may run before the claim does.
  return ownerByGuest.has(contents) || (admitted !== null && contents.getType() === 'webview')
}
