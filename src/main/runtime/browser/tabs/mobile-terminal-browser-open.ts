import type { RuntimeMobileSessionBrowserTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeNavigationTarget } from '../../../../shared/remote-runtime/session-graph/runtime-navigation'
import {
  assertClientOpenableUrl,
  openBrowserUrlOnClient,
  type BrowserClientPageOpeningHost
} from '../client-pages/browser-client-page-opening'
import type { RuntimeBrowserCommandHost } from '../commands/browser-command-contracts'

export type MobileServerTabCreateInput = [
  {
    url: string
    worktree: string
    placement: { kind: 'server' }
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
  canCreateServerTab: boolean
  createServerTab: (...args: MobileServerTabCreateInput) => Promise<{ browserPageId: string }>
  signal?: AbortSignal
}): Promise<{ browserPageId: string | null }> {
  assertClientOpenableUrl(options.params.url)
  const mobileViewing =
    typeof options.params.paneKey === 'string' &&
    options.params.paneKey.length > 0 &&
    options.host.hasMobileTerminalViewer?.(options.params.paneKey) === true
  if (mobileViewing && options.canCreateServerTab) {
    const created = await options.createServerTab(
      {
        url: options.params.url,
        worktree: options.params.worktree,
        placement: { kind: 'server' },
        activate: false,
        navigation: 'caller'
      },
      { clientKind: 'mobile', signal: options.signal }
    )
    const worktree = await options.host.resolveBrowserWorkspace(options.params.worktree)
    await options.host.followBrowserTabOnMobile?.(worktree.id, created.browserPageId)
    return created
  }
  if (options.params.onlyWhenMobileViewing) {
    return { browserPageId: null }
  }
  return openBrowserUrlOnClient(options.host, options.params, options.signal)
}

export async function followCreatedBrowserTabOnMobile(
  runtime: {
    hasOffscreenBrowser: boolean
    hydrateHeadlessTabs(worktreeId: string): void
    getMobileSessionSnapshot(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
    graphSyncCallbacks: (() => void)[]
    getMobileClientNavigationIds(worktreeId: string): string[]
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
  browserPageId: string
): Promise<void> {
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
    tab = await new Promise<RuntimeMobileSessionBrowserTab | undefined>((resolve) => {
      const check = (): void => {
        const found = findBrowserTab()
        if (!found) {
          return
        }
        clearTimeout(timeout)
        const idx = runtime.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          runtime.graphSyncCallbacks.splice(idx, 1)
        }
        resolve(found)
      }
      const timeout = setTimeout(() => {
        const idx = runtime.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          runtime.graphSyncCallbacks.splice(idx, 1)
        }
        resolve(findBrowserTab())
      }, 3_000)
      runtime.graphSyncCallbacks.push(check)
    })
  }
  if (!tab) {
    return
  }
  const mobileIds = runtime.getMobileClientNavigationIds(worktreeId)
  if (mobileIds.length === 0) {
    return
  }
  const snapshot = await runtime.getMobileSessionTabsForWorktree(worktreeId)
  for (const clientNavigationId of mobileIds) {
    runtime.applyTabNavigation(snapshot, tab.id, 'caller', clientNavigationId, true)
  }
}
