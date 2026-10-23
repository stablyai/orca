import type { BrowserExtensionActionResult } from '../../shared/browser-extension-types'
import type {
  BrowserExtensionAnchorRect,
  BrowserExtensionPopupRequest,
  BrowserExtensionToolbarState
} from '../../shared/browser-extension-toolbar-types'

/** window.api.browser members behind the browser toolbar's extension buttons. */
export type BrowserExtensionToolbarApi = {
  /** Null when the page's session runs no extensions (route, SSH and doc-preview pages). */
  extensionsToolbarState: (args: {
    browserPageId: string
  }) => Promise<BrowserExtensionToolbarState | null>
  extensionsSetPinned: (args: {
    profileId: string
    extensionId: string
    pinned: boolean
  }) => Promise<BrowserExtensionActionResult>
  /** A button click; `popupOnly` answers action.openPopup. */
  extensionsActivateAction: (args: {
    browserPageId: string
    extensionId: string
    anchor: BrowserExtensionAnchorRect
    popupOnly?: boolean
  }) => Promise<BrowserExtensionActionResult>
  /** The favicon for a tab showing an extension page, as a data URL. */
  extensionsPageIcon: (args: { browserPageId: string }) => Promise<string | null>
  onExtensionsToolbarChanged: (callback: (data: { profileId: string }) => void) => () => void
  onExtensionsPopupRequested: (
    callback: (request: BrowserExtensionPopupRequest) => void
  ) => () => void
  /** Main asks the renderer to activate a browser page (tabs.update({active: true})). */
  onRequestTabActivate: (
    callback: (data: { requestId: string; browserPageId: string }) => void
  ) => () => void
  replyTabActivate: (reply: { requestId: string; error?: string }) => void
}
