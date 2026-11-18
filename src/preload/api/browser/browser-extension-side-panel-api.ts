import type { BrowserExtensionSidePanel } from '../../../shared/browser/extensions/browser-extension-side-panel-types'

/** window.api.browser members behind extension side panels docked in browser workspaces. */
export type BrowserExtensionSidePanelApi = {
  extensionsSidePanels: () => Promise<BrowserExtensionSidePanel[]>
  /** The one-use webview src main redeems for this panel; null once it is gone or attached. */
  extensionsSidePanelAttach: (args: { panelId: string }) => Promise<string | null>
  extensionsSidePanelClose: (args: { panelId: string }) => Promise<void>
  /** The panel now shows beside this page; its keys and clicks act for that page. */
  extensionsSidePanelShown: (args: { panelId: string; browserPageId: string }) => Promise<void>
  onExtensionsSidePanelsChanged: (
    callback: (panels: BrowserExtensionSidePanel[]) => void
  ) => () => void
}
