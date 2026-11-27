import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'
import {
  assertClientOpenableUrl,
  openBrowserUrlOnClient,
  type BrowserClientPageOpeningHost
} from '../client-pages/browser-client-page-opening'
import type {
  FollowMobileBrowserTabOptions,
  RuntimeBrowserCommandHost
} from '../commands/browser-command-contracts'
import { waitForGraphSyncValue } from '../../session-lifecycle/projection/server-page-client-popup-follow'

export type MobileServerTabCreateInput = [
  {
    url: string
    worktree: string
    placement: { kind: 'server' }
    waitForRegistration: true
    activate: false
    navigation: 'caller'
  },
  { clientKind: 'mobile'; signal?: AbortSignal }
]

export async function openUrlForMobileOrClient(options: {
  host: BrowserClientPageOpeningHost &
    Pick<RuntimeBrowserCommandHost, 'hasMobileTerminalViewer' | 'followBrowserTabOnMobile'>
  params: {
    url: string
    worktree: string
    paneKey?: string
    onlyWhenMobileViewing?: boolean
  }
  createServerTab?: (...args: MobileServerTabCreateInput) => Promise<{ browserPageId: string }>
  closeServerTab?: (browserPageId: string, worktree: string) => Promise<void>
  signal?: AbortSignal
}): Promise<{ browserPageId: string | null }> {
  assertClientOpenableUrl(options.params.url)
  const paneKey =
    typeof options.params.paneKey === 'string' && options.params.paneKey.length > 0
      ? options.params.paneKey
      : undefined
  const worktree =
    paneKey && options.createServerTab
      ? await options.host.resolveBrowserWorkspace(options.params.worktree)
      : undefined
  const mobileViewing =
    paneKey !== undefined && options.host.hasMobileTerminalViewer?.(paneKey, worktree?.id) === true
  if (mobileViewing && options.createServerTab && worktree) {
    const created = await options.createServerTab(
      {
        url: options.params.url,
        worktree: options.params.worktree,
        placement: { kind: 'server' },
        waitForRegistration: true,
        activate: false,
        navigation: 'caller'
      },
      { clientKind: 'mobile', signal: options.signal }
    )
    const delivered =
      (await options.host
        .followBrowserTabOnMobile?.(worktree.id, created.browserPageId, {
          paneKey,
          signal: options.signal
        })
        ?.catch(() => false)) ?? false
    if (!delivered && options.params.onlyWhenMobileViewing) {
      await options.closeServerTab?.(created.browserPageId, options.params.worktree).catch(() => {})
      return { browserPageId: null }
    }
    return created
  }
  if (options.params.onlyWhenMobileViewing) {
    return { browserPageId: null }
  }
  return openBrowserUrlOnClient(options.host, options.params, options.signal)
}

export function activeMobileViewerClientIdsForPane(
  source: {
    getLeafPtyId(tabId: string, leafId: string): string | null | undefined
    getPanePtyId(paneKey: string): string | null | undefined
    getDisplayMode(ptyId: string): string
    getDriverKind?(ptyId: string): string
    getSubscribers(ptyId: string): Iterable<{ clientId: string; viewport: unknown }> | undefined
    getMobileListenerIds?(worktreeId: string): string[]
    getClientActiveTabId?(clientId: string, worktreeId: string): string | null
    getMobileSessionSnapshot?(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  },
  paneKey: string,
  worktreeId?: string
): string[] {
  const parsed = parsePaneKey(paneKey)
  const ptyId =
    (parsed ? source.getLeafPtyId(parsed.tabId, parsed.leafId) : null) ??
    source.getPanePtyId(paneKey) ??
    null
  const desktopReclaimed =
    ptyId !== null &&
    (source.getDriverKind
      ? source.getDriverKind(ptyId) === 'desktop'
      : source.getDisplayMode(ptyId) === 'desktop')
  if (desktopReclaimed) {
    return []
  }
  const ptyViewers =
    ptyId !== null
      ? [...(source.getSubscribers(ptyId) ?? [])]
          .filter((s) => s.viewport !== null)
          .map((s) => s.clientId)
      : []
  const tabId = parsed?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
  if (!worktreeId || !source.getMobileListenerIds) {
    return ptyViewers
  }
  const listenerIds = source.getMobileListenerIds(worktreeId)
  if (listenerIds.length === 0 || (!tabId && !ptyId)) {
    return []
  }
  // Resolve in the pairedDeviceId namespace used by session.tabs navigation so multi-device targeting stays isolated.
  const snapshot = source.getMobileSessionSnapshot?.(worktreeId)
  const matchingTabIds = new Set(
    snapshot?.tabs
      .filter(
        (t) =>
          (parsed
            ? t.type === 'terminal' && t.parentTabId === parsed.tabId && t.leafId === parsed.leafId
            : tabId !== null &&
              (t.id === tabId || (t.type === 'terminal' && t.parentTabId === tabId))) ||
          (ptyId !== null && t.type === 'terminal' && t.ptyId === ptyId)
      )
      .map((t) => t.id) ?? (tabId ? [tabId] : [])
  )
  const ptyViewerSet = new Set(ptyViewers)
  return listenerIds.filter((clientId) => {
    if (ptyViewerSet.has(clientId)) {
      return true
    }
    const activeId = source.getClientActiveTabId?.(clientId, worktreeId) ?? snapshot?.activeTabId
    return Boolean(activeId && matchingTabIds.has(activeId))
  })
}

export function selectTargetMobileNavigationIds(
  listenerIds: readonly string[],
  paneViewerClientIds?: readonly string[]
): string[] {
  const uniqueListeners = [...new Set(listenerIds)]
  if (!paneViewerClientIds) {
    return uniqueListeners
  }
  const viewerSet = new Set(paneViewerClientIds)
  return uniqueListeners.filter((id) => viewerSet.has(id))
}

export function createMobileBrowserOpenRuntimeHost(runtime: {
  getLeafPtyId(tabId: string, leafId: string): string | null | undefined
  getPanePtyId(paneKey: string): string | null | undefined
  getDisplayMode(ptyId: string): string
  getDriverKind?(ptyId: string): string
  getSubscribers(ptyId: string): Iterable<{ clientId: string; viewport: unknown }> | undefined
  getMobileListenerIds(worktreeId: string): string[]
  getClientActiveTabId?(clientId: string, worktreeId: string): string | null
  hasOffscreenBrowser(): boolean
  hydrateHeadlessTabs(worktreeId: string): void
  getMobileSessionSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  graphSyncCallbacks: (() => void)[]
  getMobileSessionTabsForWorktree(worktreeId: string): Promise<RuntimeMobileSessionTabsResult>
  applyTabNavigation(
    snapshot: RuntimeMobileSessionTabsResult,
    activeTabId: string,
    navigation: RuntimeNavigationTarget,
    clientNavigationId: string,
    callerFollows: boolean
  ): void
}) {
  return {
    hasMobileTerminalViewer(paneKey: string, worktreeId?: string): boolean {
      const viewers = activeMobileViewerClientIdsForPane(runtime, paneKey, worktreeId)
      return (
        viewers.length > 0 && (!worktreeId || runtime.getMobileListenerIds(worktreeId).length > 0)
      )
    },
    followBrowserTabOnMobile(
      worktreeId: string,
      browserPageId: string,
      options?: FollowMobileBrowserTabOptions
    ): Promise<boolean> {
      return followCreatedBrowserTabOnMobile(
        {
          hasOffscreenBrowser: runtime.hasOffscreenBrowser(),
          hydrateHeadlessTabs: runtime.hydrateHeadlessTabs,
          getMobileSessionSnapshot: runtime.getMobileSessionSnapshot,
          graphSyncCallbacks: runtime.graphSyncCallbacks,
          getMobileClientNavigationIds: (id, paneKey) =>
            selectTargetMobileNavigationIds(
              runtime.getMobileListenerIds(id),
              paneKey ? activeMobileViewerClientIdsForPane(runtime, paneKey, id) : undefined
            ),
          getMobileSessionTabsForWorktree: runtime.getMobileSessionTabsForWorktree,
          applyTabNavigation: runtime.applyTabNavigation
        },
        worktreeId,
        browserPageId,
        options
      )
    }
  }
}

export async function followCreatedBrowserTabOnMobile(
  runtime: {
    hasOffscreenBrowser: boolean
    hydrateHeadlessTabs(worktreeId: string): void
    getMobileSessionSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
    graphSyncCallbacks: (() => void)[]
    getMobileClientNavigationIds(worktreeId: string, paneKey?: string): string[]
    getMobileSessionTabsForWorktree(worktreeId: string): Promise<RuntimeMobileSessionTabsResult>
    applyTabNavigation(
      snapshot: RuntimeMobileSessionTabsResult,
      activeTabId: string,
      navigation: RuntimeNavigationTarget,
      clientNavigationId: string,
      callerFollows: boolean
    ): void
  },
  worktreeId: string,
  browserPageId: string,
  options?: FollowMobileBrowserTabOptions
): Promise<boolean> {
  const signal = options?.signal
  if (signal?.aborted) {
    return false
  }
  const findBrowserTab = (): RuntimeMobileSessionBrowserTab | undefined => {
    if (runtime.hasOffscreenBrowser) {
      runtime.hydrateHeadlessTabs(worktreeId)
    }
    return runtime
      .getMobileSessionSnapshot(worktreeId)
      ?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionBrowserTab =>
          candidate.type === 'browser' && candidate.browserPageId === browserPageId
      )
  }
  let tab = findBrowserTab()
  if (!tab && !runtime.hasOffscreenBrowser) {
    // Desktop renderer publishes the new browser tab asynchronously via syncWindowGraph.
    tab = await waitForGraphSyncValue(runtime.graphSyncCallbacks, findBrowserTab, 3_000, signal)
  }
  if (!tab || signal?.aborted) {
    return false
  }
  const mobileIds = runtime.getMobileClientNavigationIds(worktreeId, options?.paneKey)
  if (mobileIds.length === 0) {
    return false
  }
  const snapshot = await runtime.getMobileSessionTabsForWorktree(worktreeId)
  if (signal?.aborted) {
    return false
  }
  for (const clientNavigationId of mobileIds) {
    runtime.applyTabNavigation(snapshot, tab.id, 'caller', clientNavigationId, true)
  }
  return true
}
