import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import {
  navigationTargetsHost,
  resolveRuntimeNavigationTarget,
  type RuntimeNavigationTarget
} from '../../shared/runtime-navigation'

export type BrowserTabCreatePlacementKind = 'client' | 'offscreen' | 'renderer'

export const BROWSER_TAB_CREATE_PLACEMENT_KINDS = [
  'client',
  'offscreen',
  'renderer'
] as const satisfies readonly BrowserTabCreatePlacementKind[]

type BrowserTabCreatePublicationBridge = Pick<
  AgentBrowserBridge,
  'getRegisteredTabs' | 'setActiveTab'
>

export type BrowserTabCreatePublicationHost = {
  getAgentBrowserBridge(): BrowserTabCreatePublicationBridge | null
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void
  notifyHeadlessBrowserSessionTabsChanged?(worktreeId: string): void
}

export type BrowserSessionTabSelectionOptions = {
  targetGroupId?: string
  /** Required to force each caller to decide whether shared host selection moves. */
  focusesHost: boolean
  /** Paired origin and navigation audience travel together; absent for local creates. */
  caller?: { clientNavigationId: string; navigation: RuntimeNavigationTarget }
}

export type BrowserTabCreatePublication = {
  placementKind: BrowserTabCreatePlacementKind
  browserPageId: string
  worktreeId?: string
  focus: BrowserTabCreateFocusResolution
  clientNavigationId?: string
  targetGroupId?: string
}

/** Host rows come from renderer create IPC or a derived session notification.
 * none applies only without a host renderer; client placements need session-notify to appear. */
export type BrowserTabCreateHostRowSource = 'create-ipc' | 'session-notify' | 'none'

type BrowserTabCreatePublicationRules = {
  activatesBridgeTab: boolean
  marksSessionTabFocus: boolean
  notifiesSessionTabsChanged: boolean
  hostRowSource: BrowserTabCreateHostRowSource
}

// Centralize placement differences so branches cannot silently omit publication/group placement.
export const BROWSER_TAB_CREATE_PUBLICATION_RULES: Record<
  BrowserTabCreatePlacementKind,
  BrowserTabCreatePublicationRules
> = {
  client: {
    // Lease-hosted pages have no bridge WebContents.
    activatesBridgeTab: false,
    marksSessionTabFocus: true,
    notifiesSessionTabsChanged: true,
    hostRowSource: 'session-notify'
  },
  offscreen: {
    activatesBridgeTab: true,
    marksSessionTabFocus: true,
    // Hydration/navigation publish the offscreen snapshot; bare creation has nothing to announce.
    notifiesSessionTabsChanged: false,
    hostRowSource: 'none'
  },
  renderer: {
    activatesBridgeTab: true,
    // The renderer receives activate in create IPC and publishes its own snapshot.
    marksSessionTabFocus: false,
    notifiesSessionTabsChanged: false,
    hostRowSource: 'create-ipc'
  }
}

// Agent/CLI creates must not steal focus; this marker also applies the requested split group.
export function browserTabCreateTakesFocus(activate: boolean | undefined): boolean {
  return activate === true
}

export type BrowserTabCreateFocusResolution = {
  navigation: RuntimeNavigationTarget
  selects: boolean
  focusesHost: boolean
  startsActive: boolean
}

/** Paired creates default to caller-only navigation; local creates retain the all-screen default. */
export function resolveBrowserTabCreateFocus(request: {
  activate?: boolean
  navigation?: RuntimeNavigationTarget
  clientKind?: 'mobile' | 'runtime'
}): BrowserTabCreateFocusResolution {
  const navigation = resolveRuntimeNavigationTarget({
    navigation: request.navigation,
    clientKind: request.clientKind
  })
  const selects = browserTabCreateTakesFocus(request.activate)
  return {
    navigation,
    selects,
    focusesHost: selects && navigationTargetsHost(navigation),
    startsActive: browserTabCreateClientPageStartsActive(request.activate)
  }
}

// Omitted activate still selects the client registry page, unlike opt-in UI focus.
// Preserve that hand-written RPC behavior even though shipped callers send an explicit boolean.
export function browserTabCreateClientPageStartsActive(activate: boolean | undefined): boolean {
  return activate !== false
}

/** bridge covers renderer/offscreen, whose bridge already updates its own active state. */
export type BrowserTabSwitchPlacementKind = 'client' | 'bridge'

export const BROWSER_TAB_SWITCH_PLACEMENT_KINDS = [
  'client',
  'bridge'
] as const satisfies readonly BrowserTabSwitchPlacementKind[]

export type BrowserTabSwitchPublication = {
  placementKind: BrowserTabSwitchPlacementKind
  browserPageId: string
  worktreeId?: string
  focus?: boolean
}

export const BROWSER_TAB_SWITCH_PUBLICATION_RULES: Record<
  BrowserTabSwitchPlacementKind,
  { marksSessionTabFocus: boolean; notifiesSessionTabsChanged: boolean }
> = {
  client: {
    marksSessionTabFocus: true,
    // Registry selection reaches clients only through republished snapshots, even without focus.
    notifiesSessionTabsChanged: true
  },
  bridge: {
    marksSessionTabFocus: true,
    // Unfocused bridge switches change no snapshot; focused ones publish through the focus marker.
    notifiesSessionTabsChanged: false
  }
}

// Agent/CLI switches must opt in before moving a client's view.
export function browserTabSwitchTakesFocus(focus: boolean | undefined): boolean {
  return focus === true
}

export function publishSwitchedBrowserSessionTab(
  host: BrowserTabCreatePublicationHost,
  publication: BrowserTabSwitchPublication
): void {
  const rules = BROWSER_TAB_SWITCH_PUBLICATION_RULES[publication.placementKind]
  if (rules.notifiesSessionTabsChanged && publication.worktreeId !== undefined) {
    host.notifyHeadlessBrowserSessionTabsChanged?.(publication.worktreeId)
  }
  if (rules.marksSessionTabFocus && browserTabSwitchTakesFocus(publication.focus)) {
    // Switch has no navigation audience yet; preserve its existing host-facing semantics.
    host.markHeadlessBrowserSessionTabActive?.(publication.worktreeId, publication.browserPageId, {
      focusesHost: true
    })
  }
}

export function publishCreatedBrowserSessionTab(
  host: BrowserTabCreatePublicationHost,
  publication: BrowserTabCreatePublication
): void {
  const rules = BROWSER_TAB_CREATE_PUBLICATION_RULES[publication.placementKind]
  if (rules.notifiesSessionTabsChanged && publication.worktreeId !== undefined) {
    host.notifyHeadlessBrowserSessionTabsChanged?.(publication.worktreeId)
  }
  if (rules.activatesBridgeTab) {
    const bridge = host.getAgentBrowserBridge()
    const webContentsId = bridge
      ?.getRegisteredTabs(publication.worktreeId)
      .get(publication.browserPageId)
    if (bridge && webContentsId != null) {
      bridge.setActiveTab(webContentsId, publication.worktreeId)
    }
  }
  // Caller-only creates still need this call to place the tab in the requested group.
  if (rules.marksSessionTabFocus && publication.focus.selects) {
    host.markHeadlessBrowserSessionTabActive?.(publication.worktreeId, publication.browserPageId, {
      ...(publication.targetGroupId !== undefined
        ? { targetGroupId: publication.targetGroupId }
        : {}),
      focusesHost: publication.focus.focusesHost,
      ...(publication.clientNavigationId !== undefined
        ? {
            caller: {
              clientNavigationId: publication.clientNavigationId,
              navigation: publication.focus.navigation
            }
          }
        : {})
    })
  }
}
