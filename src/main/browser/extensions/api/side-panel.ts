import { webContents } from 'electron'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import {
  BrowserExtensionApiError,
  defineBrowserExtensionMethod,
  registerBrowserExtensionNamespace,
  type BrowserExtensionCaller
} from '../api-runtime/browser-extension-namespace-registry'
import { hasBrowserExtensionUserGesture } from '../permissions/browser-extension-user-gesture'
import {
  getActiveBrowserTabId,
  requireCallerTab
} from '../tabs-and-windows/browser-extension-tab-model'
import {
  WINDOW_ID_CURRENT,
  getBrowserExtensionMainWindow
} from '../tabs-and-windows/browser-extension-window-model'
import {
  closeBrowserExtensionSidePanels,
  findBrowserExtensionSidePanels
} from '../side-panel/browser-extension-side-panel-host'
import {
  getOpenSidePanelOnActionClick,
  getSidePanelOptionsForTab,
  getSidePanelTabOptions,
  normalizeSidePanelPath,
  setOpenSidePanelOnActionClick
} from '../side-panel/browser-extension-side-panel-options'
import {
  changeBrowserExtensionSidePanelOptions,
  openBrowserExtensionSidePanelForWindow,
  openBrowserExtensionSidePanelOnTab,
  resolveSidePanelWorkspace
} from '../side-panel/browser-extension-side-panel-open'

const tabIdSchema = lazyZodSchema(() => z.number().int().nonnegative())
const targetSchema = lazyZodSchema(() =>
  z.object({ tabId: tabIdSchema.optional(), windowId: z.number().int().optional() }).loose()
)

/** Orca's browser tabs all sit in its one main window; popouts have no side panel. */
function requireMainWindowId(windowId: number): number {
  const mainWindow = getBrowserExtensionMainWindow()
  const resolved = windowId === WINDOW_ID_CURRENT ? mainWindow?.id : windowId
  if (!mainWindow || resolved !== mainWindow.id) {
    throw new BrowserExtensionApiError(`No side panel for windowId: ${windowId}`)
  }
  return resolved
}

function requireSidePanelTab(caller: BrowserExtensionCaller, tabId: number): number {
  const entry = requireCallerTab(caller, tabId)
  if (entry.windowType !== 'normal') {
    throw new BrowserExtensionApiError(`No side panel for tabId: ${tabId}`)
  }
  return tabId
}

function open(caller: BrowserExtensionCaller, target: z.infer<typeof targetSchema>): void {
  if (!hasBrowserExtensionUserGesture(caller)) {
    throw new BrowserExtensionApiError(
      '`sidePanel.open()` may only be called in response to a user gesture.'
    )
  }
  const { tabId, windowId } = target
  if (tabId === undefined && windowId === undefined) {
    throw new BrowserExtensionApiError('At least one of `tabId` and `windowId` must be provided')
  }
  if (windowId !== undefined) {
    requireMainWindowId(windowId)
  }
  if (tabId !== undefined) {
    openBrowserExtensionSidePanelOnTab(
      caller.browserProfileId,
      caller.extension,
      requireSidePanelTab(caller, tabId),
      `tabId: ${tabId}`
    )
    return
  }
  // Why the active tab: Orca's window holds every workspace; the panel opens in the one in view.
  const activeTabId = getActiveBrowserTabId()
  const activeTab = activeTabId === null ? null : webContents.fromId(activeTabId)
  if (activeTabId === null || activeTab?.session !== caller.session) {
    throw new BrowserExtensionApiError(`No active side panel for windowId: ${windowId}`)
  }
  openBrowserExtensionSidePanelForWindow(
    caller.browserProfileId,
    caller.extension,
    activeTabId,
    `windowId: ${windowId}`
  )
}

function close(caller: BrowserExtensionCaller, target: z.infer<typeof targetSchema>): void {
  const { tabId, windowId } = target
  if (tabId === undefined && windowId === undefined) {
    throw new BrowserExtensionApiError('At least one of `tabId` and `windowId` must be provided')
  }
  const profileId = caller.browserProfileId
  const extensionId = caller.extension.id
  if (tabId !== undefined) {
    requireSidePanelTab(caller, tabId)
    const tabPanels = findBrowserExtensionSidePanels(profileId, extensionId, { tabId })
    // Why reject: since Chrome 145 a tabId closes only that tab's panel, never the global one,
    // and only that tab's workspace can be showing it the global one.
    const workspaceId = resolveSidePanelWorkspace(tabId)
    const globalPanels = findBrowserExtensionSidePanels(profileId, extensionId, {
      tabId: null
    }).filter((panel) => panel.workspaceId === workspaceId)
    if (tabPanels.length === 0 && globalPanels.length > 0) {
      throw new BrowserExtensionApiError(`No active side panel for tabId: ${tabId}`)
    }
    closeBrowserExtensionSidePanels(tabPanels)
    return
  }
  requireMainWindowId(windowId ?? WINDOW_ID_CURRENT)
  closeBrowserExtensionSidePanels(
    findBrowserExtensionSidePanels(profileId, extensionId, { tabId: null })
  )
}

export function registerSidePanelNamespace(): void {
  registerBrowserExtensionNamespace('sidePanel', {
    permission: 'sidePanel',
    methods: {
      setOptions: defineBrowserExtensionMethod(
        z.tuple([
          z
            .object({
              tabId: tabIdSchema.optional(),
              path: z.string().optional(),
              enabled: z.boolean().optional()
            })
            .loose()
        ]),
        (caller, { tabId, path, enabled }) => {
          if (tabId !== undefined) {
            requireCallerTab(caller, tabId)
          }
          changeBrowserExtensionSidePanelOptions(caller.browserProfileId, caller.extension, {
            tabId,
            path:
              path === undefined ? undefined : normalizeSidePanelPath(caller.extension.id, path),
            enabled
          })
        }
      ),
      getOptions: defineBrowserExtensionMethod(
        z.tuple([z.object({ tabId: tabIdSchema.optional() }).loose()]),
        (caller, { tabId }) => {
          const options = getSidePanelOptionsForTab(
            caller.browserProfileId,
            caller.extension,
            tabId ?? null
          )
          // Why tabId only for the tab's own options: a fallback to the global ones is not tab-scoped.
          const tabScoped =
            tabId !== undefined &&
            getSidePanelTabOptions(caller.browserProfileId, caller.extension.id, tabId) !== null
          return {
            enabled: options?.enabled ?? false,
            ...(options?.path === undefined ? {} : { path: options.path }),
            ...(tabScoped ? { tabId } : {})
          }
        }
      ),
      setPanelBehavior: defineBrowserExtensionMethod(
        z.tuple([z.object({ openPanelOnActionClick: z.boolean().optional() }).loose()]),
        (caller, { openPanelOnActionClick }) => {
          if (openPanelOnActionClick !== undefined) {
            setOpenSidePanelOnActionClick(
              caller.browserProfileId,
              caller.extension.id,
              openPanelOnActionClick
            )
          }
        }
      ),
      getPanelBehavior: defineBrowserExtensionMethod(z.tuple([]), (caller) => ({
        openPanelOnActionClick: getOpenSidePanelOnActionClick(
          caller.browserProfileId,
          caller.extension.id
        )
      })),
      open: defineBrowserExtensionMethod(z.tuple([targetSchema]), open),
      close: defineBrowserExtensionMethod(z.tuple([targetSchema]), close),
      // Why always right: Orca docks the panel on the right and has no setting to move it.
      getLayout: defineBrowserExtensionMethod(z.tuple([]), () => ({ side: 'right' }))
    },
    events: ['onOpened', 'onClosed']
  })
}
