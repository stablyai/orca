import type {
  ServerPageLinkTabPresentation,
  ServerPagePopupClosure
} from '../../../browser/guest-lifecycle/popups/browser-popup-ownership'
import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'

export function bindServerPagePopupClientRuntime(runtime: {
  getActiveTabId(clientNavigationId: string, worktreeId: string): string | null
  getStoredSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
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
    closePopup: (popup: ServerPagePopupClosure) => returnClientToPopupOpener(runtime, popup),
    followLinkTab: (link: ServerPageLinkTabPresentation) =>
      followOpenedRendererLinkTabForClient(runtime, link)
  }
}

export async function returnClientToPopupOpener(
  runtime: {
    getActiveTabId(clientNavigationId: string, worktreeId: string): string | null
    getMobileSessionTabsForWorktree(worktreeId: string): Promise<RuntimeMobileSessionTabsResult>
    applyTabNavigation(
      snapshot: RuntimeMobileSessionTabsResult,
      activeTabId: string,
      navigation: RuntimeNavigationTarget,
      clientNavigationId: string,
      callerFollows: boolean
    ): void
  },
  popup: ServerPagePopupClosure
): Promise<void> {
  // Capture before any await so concurrent graph updates cannot obscure that the client was on the popup.
  if (runtime.getActiveTabId(popup.pairedDeviceId, popup.worktreeId) !== popup.browserPageId) {
    return
  }
  const snapshot = await runtime.getMobileSessionTabsForWorktree(popup.worktreeId)
  const findByPageId = (pageId: string | undefined) =>
    pageId
      ? snapshot.tabs.find(
          (candidate) => candidate.type === 'browser' && candidate.browserPageId === pageId
        )
      : undefined
  const openerTab =
    findByPageId(popup.openerBrowserPageId) ?? findByPageId(popup.fallbackOpenerBrowserPageId)
  if (!openerTab) {
    return
  }
  runtime.applyTabNavigation(snapshot, openerTab.id, 'caller', popup.pairedDeviceId, true)
}

export async function followOpenedRendererLinkTabForClient(
  runtime: {
    getStoredSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
    graphSyncCallbacks: (() => void)[]
    getMobileSessionTabsForWorktree(worktreeId: string): Promise<RuntimeMobileSessionTabsResult>
    applyTabNavigation(
      snapshot: RuntimeMobileSessionTabsResult,
      activeTabId: string,
      navigation: RuntimeNavigationTarget,
      clientNavigationId: string,
      callerFollows: boolean
    ): void
  },
  link: ServerPageLinkTabPresentation
): Promise<void> {
  const knownTabIds = new Set(
    runtime.getStoredSnapshot(link.worktreeId)?.tabs.map((tab) => tab.id) ?? []
  )
  const findAddedBrowserTab = (): RuntimeMobileSessionBrowserTab | undefined => {
    const candidates =
      runtime
        .getStoredSnapshot(link.worktreeId)
        ?.tabs.filter(
          (tab): tab is RuntimeMobileSessionBrowserTab =>
            tab.type === 'browser' && !knownTabIds.has(tab.id)
        ) ?? []
    return candidates.find((tab) => tab.url === link.url) ?? candidates[0]
  }
  const added = await new Promise<RuntimeMobileSessionBrowserTab | undefined>((resolve) => {
    const immediate = findAddedBrowserTab()
    if (immediate) {
      resolve(immediate)
      return
    }
    const cleanup = (): void => {
      clearTimeout(timeout)
      const idx = runtime.graphSyncCallbacks.indexOf(check)
      if (idx !== -1) {
        runtime.graphSyncCallbacks.splice(idx, 1)
      }
    }
    const check = (): void => {
      const found = findAddedBrowserTab()
      if (!found) {
        return
      }
      cleanup()
      resolve(found)
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve(findAddedBrowserTab())
    }, 3_000)
    runtime.graphSyncCallbacks.push(check)
  })
  if (!added) {
    return
  }
  const snapshot = await runtime.getMobileSessionTabsForWorktree(link.worktreeId)
  runtime.applyTabNavigation(snapshot, added.id, 'caller', link.pairedDeviceId, true)
}
