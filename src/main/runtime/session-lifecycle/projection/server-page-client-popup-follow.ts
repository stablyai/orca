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
  // Bail out if the client explicitly chose another tab while awaiting the snapshot.
  // (Popup retirement alone preserves stored selection.activeTabId via project().)
  if (runtime.getActiveTabId(popup.pairedDeviceId, popup.worktreeId) !== popup.browserPageId) {
    return
  }
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

export function waitForGraphSyncValue<T>(
  graphSyncCallbacks: (() => void)[],
  read: () => T | undefined,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T | undefined> {
  const immediate = read()
  if (immediate !== undefined || signal?.aborted) {
    return Promise.resolve(signal?.aborted ? undefined : immediate)
  }
  return new Promise<T | undefined>((resolve) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      const idx = graphSyncCallbacks.indexOf(check)
      if (idx !== -1) {
        graphSyncCallbacks.splice(idx, 1)
      }
    }
    const check = (): void => {
      const found = read()
      if (found === undefined) {
        return
      }
      cleanup()
      resolve(found)
    }
    const onAbort = (): void => {
      cleanup()
      resolve(undefined)
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve(read())
    }, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    graphSyncCallbacks.push(check)
  })
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
  const findCreatedBrowserTab = (): RuntimeMobileSessionBrowserTab | undefined =>
    runtime
      .getStoredSnapshot(link.worktreeId)
      ?.tabs.find(
        (tab): tab is RuntimeMobileSessionBrowserTab =>
          tab.type === 'browser' && tab.browserPageId === link.browserPageId
      )
  const added = await waitForGraphSyncValue(
    runtime.graphSyncCallbacks,
    findCreatedBrowserTab,
    3_000
  )
  if (!added) {
    return
  }
  const snapshot = await runtime.getMobileSessionTabsForWorktree(link.worktreeId)
  runtime.applyTabNavigation(snapshot, added.id, 'caller', link.pairedDeviceId, true)
}
