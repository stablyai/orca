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
import type {
  FollowMobileBrowserTabOptions,
  RuntimeBrowserCommandHost
} from '../commands/browser-command-contracts'
import { waitForGraphSyncValue } from '../../session-lifecycle/projection/server-page-client-popup-follow'
import {
  activeMobileViewerClientIdsForPane,
  selectTargetMobileNavigationIds
} from './mobile-terminal-pane-viewers'

export { activeMobileViewerClientIdsForPane, selectTargetMobileNavigationIds }

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

// Strictly below the CLI's 5s --if-mobile-viewing timeout so the host aborts, cleans up, and answers null before fallback runs.
const MOBILE_SHIM_OPEN_DEADLINE_MS = 3_500

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  if (signal.aborted) {
    return Promise.resolve(null)
  }
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = (): void => resolve(null)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(signal.aborted ? null : value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          resolve(null)
        } else {
          reject(error)
        }
      }
    )
  })
}

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
  mobileOpenDeadlineMs?: number
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
    const onlyWhenMobile = options.params.onlyWhenMobileViewing === true
    const deadlineController = onlyWhenMobile ? new AbortController() : null
    const onCallerAbort = (): void => deadlineController?.abort()
    if (deadlineController) {
      if (options.signal?.aborted) {
        deadlineController.abort()
      } else {
        options.signal?.addEventListener('abort', onCallerAbort, { once: true })
      }
    }
    const deadlineTimer = deadlineController
      ? setTimeout(
          () => deadlineController.abort(),
          options.mobileOpenDeadlineMs ?? MOBILE_SHIM_OPEN_DEADLINE_MS
        )
      : undefined
    const effectiveSignal = deadlineController?.signal ?? options.signal
    try {
      const createPromise = options.createServerTab(
        {
          url: options.params.url,
          worktree: options.params.worktree,
          placement: { kind: 'server' },
          waitForRegistration: true,
          activate: false,
          navigation: 'caller'
        },
        { clientKind: 'mobile', signal: effectiveSignal }
      )
      const created = deadlineController
        ? await raceWithAbort(createPromise, deadlineController.signal)
        : await createPromise
      if (!created || deadlineController?.signal.aborted) {
        // Retire any tab that finishes creating after the deadline so the shim's fallback never duplicates it.
        void createPromise.then(
          (late) =>
            options.closeServerTab?.(late.browserPageId, options.params.worktree).catch(() => {}),
          () => {}
        )
        return { browserPageId: null }
      }
      const followPromise =
        options.host
          .followBrowserTabOnMobile?.(worktree.id, created.browserPageId, {
            paneKey,
            signal: effectiveSignal
          })
          ?.catch(() => false) ?? Promise.resolve(false)
      const delivered =
        (deadlineController
          ? await raceWithAbort(followPromise, deadlineController.signal)
          : await followPromise) === true
      if (onlyWhenMobile && (!delivered || deadlineController?.signal.aborted)) {
        await options
          .closeServerTab?.(created.browserPageId, options.params.worktree)
          .catch(() => {})
        return { browserPageId: null }
      }
      return created
    } finally {
      clearTimeout(deadlineTimer)
      options.signal?.removeEventListener('abort', onCallerAbort)
    }
  }
  if (options.params.onlyWhenMobileViewing) {
    return { browserPageId: null }
  }
  return openBrowserUrlOnClient(options.host, options.params, options.signal)
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
