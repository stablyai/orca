import type {
  BrowserExtensionAction,
  BrowserExtensionActionAnchor,
  BrowserExtensionActionRequestedEvent,
  BrowserInstalledExtension
} from '../../shared/browser-guest-events'

/** Chrome extensions in Orca's browser: toolbar buttons, menus, and the installed list. */
export type BrowserExtensionsApi = {
  runExtensionMenuItem: (args: { browserPageId: string; index: number }) => void
  onExtensionActionRequested: (
    callback: (event: BrowserExtensionActionRequestedEvent) => void
  ) => () => void
  extensionActions: (args: { browserPageId: string }) => Promise<BrowserExtensionAction[]>
  onExtensionActionsChanged: (callback: () => void) => () => void
  /** Opens the popup under `anchor`, or clicks an extension that has none. */
  activateExtensionAction: (args: {
    browserPageId: string
    extensionId: string
    anchor: BrowserExtensionActionAnchor
  }) => void
  showExtensionActionMenu: (args: { browserPageId: string; extensionId: string }) => void
  installedExtensions: () => Promise<BrowserInstalledExtension[]>
  onInstalledExtensionsChanged: (callback: () => void) => () => void
  setExtensionEnabled: (args: { extensionId: string; enabled: boolean }) => Promise<void>
  removeExtension: (args: { extensionId: string }) => Promise<void>
  openExtensionOptions: (args: { extensionId: string }) => Promise<void>
}
