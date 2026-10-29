import type {
  BrowserExtensionContextMenuClick,
  BrowserExtensionContextMenuPayload
} from '../../shared/browser-extension-context-menu-types'

/** window.api.browser members behind extension items in the page and toolbar-button menus. */
export type BrowserExtensionContextMenuApi = {
  extensionsContextMenuClick: (args: BrowserExtensionContextMenuClick) => Promise<boolean>
  /** An extension's 'action' context items for its toolbar button menu; click with the token. */
  extensionsActionContextMenu: (args: {
    profileId: string
    extensionId: string
    browserPageId?: string
  }) => Promise<BrowserExtensionContextMenuPayload | null>
}
