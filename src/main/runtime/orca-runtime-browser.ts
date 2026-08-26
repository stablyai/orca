/* eslint-disable max-lines -- Why: this file is a command adapter for one external surface, Agent Browser automation. It stays separate from OrcaRuntimeService so runtime state does not grow further while browser routing remains easy to scan in one place. */
import { randomUUID } from 'node:crypto'
import { ipcMain, webContents, type BrowserWindow } from 'electron'
import type {
  BrowserBackResult,
  BrowserCaptureStartResult,
  BrowserCheckResult,
  BrowserCaptureStopResult,
  BrowserClearResult,
  BrowserClickResult,
  BrowserConsoleResult,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserDetectProfilesResult,
  BrowserDragResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserGeolocationResult,
  BrowserGotoResult,
  BrowserHoverResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserKeypressResult,
  BrowserNetworkLogResult,
  BrowserPdfResult,
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileImportFromBrowserResult,
  BrowserProfileListResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserScreencastResult,
  BrowserScrollResult,
  BrowserSelectAllResult,
  BrowserSelectResult,
  BrowserSnapshotResult,
  BrowserTabCurrentResult,
  BrowserTabListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult,
  BrowserTabShowResult,
  BrowserTabSwitchResult,
  BrowserTypeResult,
  BrowserUploadResult,
  BrowserViewportResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import type {
  BrowserCertificateProceedResult,
  BrowserSessionUserAgentMode
} from '../../shared/browser-workspace-types'
import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import type { BrowserPageCreationPlacement } from '../../shared/browser-client-host-placement'
import type { ExecutionHostId } from '../../shared/execution-host'
import { browserNetworkExecutionHostKey } from '../browser/browser-network-execution-route'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import type { BrowserBackend } from '../browser/browser-backend'
import { browserCertificateTrustController, browserManager } from '../browser/browser-manager'
import { BrowserError } from '../browser/cdp-bridge'
import { startBrowserScreencast } from '../browser/browser-screencast-stream'
import {
  browserScreencastFrameBudgetsEqual,
  mergeBrowserScreencastFrameBudgets
} from '../browser/browser-screencast-frame-budget'
import type {
  BrowserScreencastFrameBudget,
  BrowserScreencastSession,
  BrowserScreencastViewport
} from '../browser/browser-screencast-stream-types'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../browser/browser-cookie-import'
import {
  waitForTabRegistration,
  waitForWorktreeTabRegistration
} from '../ipc/browser-tab-registration-wait'
import { sendRemoteBrowserScreencastFrame } from './remote-browser-screencast-frame-admission'
import {
  INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY,
  recordScreencastSubscriberSend,
  screencastSubscriberIsGhost,
  type ScreencastSubscriberDeliveryState
} from './browser-screencast-ghost-subscriber-eviction'
import {
  publishCreatedBrowserSessionTab,
  publishSwitchedBrowserSessionTab,
  resolveBrowserTabCreateFocus,
  type BrowserSessionTabSelectionOptions
} from './browser-tab-create-publication'
import type { RuntimeNavigationTarget } from '../../shared/runtime-navigation'
import type { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import {
  closeRuntimeBrowserClientPage,
  createRuntimeBrowserClientPage,
  navigateRuntimeBrowserClientPage
} from './runtime-browser-client-page-creation'
import type {
  RuntimeBrowserClientPage,
  RuntimeBrowserPageRegistry
} from './runtime-browser-page-registry'

export type BrowserCommandTargetParams = {
  worktree?: string
  page?: string
}

type ResolvedBrowserCommandTarget = {
  worktreeId?: string
  browserPageId?: string
}

type ResolvedBrowserPageWebContents = {
  browserPageId: string
  webContents: Electron.WebContents
}

type BrowserScreencastParams = {
  format: 'jpeg' | 'png'
  quality?: number
  maxWidth?: number
  maxHeight?: number
  viewportWidth?: number
  viewportHeight?: number
  deviceScaleFactor?: number
  mobile?: boolean
  everyNthFrame?: number
  minFrameIntervalMs?: number
} & BrowserCommandTargetParams

type BrowserScreencastStartResult = {
  subscriptionId: string
  ready: Extract<BrowserScreencastResult, { type: 'ready' }>
  // The frame budget belongs to the shared page, not to one subscriber's handle.
  session: Omit<BrowserScreencastSession, 'updateFrameBudget'>
  // Why: callers gate frames until they have emitted `ready`, and the snapshot captured
  // for a joining subscriber lands inside that window. This replays it once the gate opens.
  flushPendingFrame: () => void
}

type ActiveBrowserScreencastSubscriber = {
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
  emit?: (event: BrowserScreencastResult) => void
  done: Promise<void>
  resolveDone: () => void
  viewport: BrowserScreencastViewport
  budget: BrowserScreencastFrameBudget
  pendingFrame: Uint8Array<ArrayBufferLike> | null
  // Why: identifies the viewer across reconnects, which the RPC connectionId cannot — a new
  // socket never reuses the old id, so a reconnecting device would stack a second subscription.
  pairedDeviceId?: string
  delivery: ScreencastSubscriberDeliveryState
}

type ActiveBrowserScreencastPage = {
  format: 'jpeg' | 'png'
  session: BrowserScreencastSession | null
  started: Promise<BrowserScreencastSession>
  stopping: boolean
  subscribers: Map<string, ActiveBrowserScreencastSubscriber>
  viewportOwnerSubscriptionId: string | null
  appliedBudget: BrowserScreencastFrameBudget
}

async function applySharedScreencastFrameBudget(
  active: ActiveBrowserScreencastPage,
  session: BrowserScreencastSession
): Promise<void> {
  const merged = mergeBrowserScreencastFrameBudgets(
    Array.from(active.subscribers.values(), (subscriber) => subscriber.budget)
  )
  if (!merged || browserScreencastFrameBudgetsEqual(merged, active.appliedBudget)) {
    return
  }
  active.appliedBudget = merged
  await session.updateFrameBudget(merged)
}

function normalizeScreencastViewport(params: BrowserScreencastParams): BrowserScreencastViewport {
  return {
    viewportWidth: clampOptionalInteger(params.viewportWidth, 320, 3840),
    viewportHeight: clampOptionalInteger(params.viewportHeight, 240, 2160),
    deviceScaleFactor: clampOptionalNumber(params.deviceScaleFactor, 1, 4),
    mobile: params.mobile === true
  }
}

function normalizeScreencastFrameBudget(
  params: BrowserScreencastParams
): BrowserScreencastFrameBudget {
  return {
    quality: clampInteger(params.quality, 10, 100, 70),
    maxWidth: clampInteger(params.maxWidth, 320, 3840, 1440),
    maxHeight: clampInteger(params.maxHeight, 240, 2160, 1200),
    everyNthFrame: clampInteger(params.everyNthFrame, 1, 10, 2),
    minFrameIntervalMs: clampInteger(params.minFrameIntervalMs, 0, 1000, 0)
  }
}

function hasScreencastViewportSize(viewport: BrowserScreencastViewport): boolean {
  return viewport.viewportWidth !== undefined && viewport.viewportHeight !== undefined
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clampOptionalInteger(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, Math.round(value)))
}

function clampOptionalNumber(
  value: number | undefined,
  min: number,
  max: number
): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined
  }
  return Math.min(max, Math.max(min, value))
}

export type RuntimeBrowserCommandHost = {
  getAgentBrowserBridge(): AgentBrowserBridge | null
  resolveWorktreeSelector(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserWorkspace(selector: string): Promise<{
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }>
  resolveBrowserNetworkExecutionHost(worktree?: {
    id: string
    repoId?: string
    hostId?: ExecutionHostId
  }): BrowserNetworkExecutionHost | Promise<BrowserNetworkExecutionHost>
  getBrowserHostLeaseRegistry(): BrowserHostLeaseRegistry
  getRuntimeBrowserPageRegistry(): RuntimeBrowserPageRegistry
  getAuthoritativeWindow(): BrowserWindow
  getAvailableAuthoritativeWindow(): BrowserWindow | null
  // Why: headless serve backs pages with a main-process offscreen backend; null when the environment can't support offscreen browsing.
  getOffscreenBrowserBackend(): BrowserBackend | null
  // Why: the session-tab snapshot owns focus, so a headless create must mark itself active or paired clients snap back to a terminal.
  markHeadlessBrowserSessionTabActive?(
    worktreeId: string | undefined,
    browserPageId: string,
    options?: BrowserSessionTabSelectionOptions
  ): void
  notifyHeadlessBrowserSessionTabsChanged?(worktreeId: string): void
  /** True when a runtime-owned session row for that page existed and was retired. */
  retireRuntimeOwnedBrowserSessionTab?(worktreeId: string, browserPageId: string): boolean | void
}

export class RuntimeBrowserCommands {
  private readonly activeScreencastsByPageId = new Map<string, ActiveBrowserScreencastPage>()

  constructor(private readonly host: RuntimeBrowserCommandHost) {}

  private requireAgentBrowserBridge(): AgentBrowserBridge {
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    return bridge
  }

  /**
   * Retires a session row for a page nothing here can close any more.
   *
   * A client-hosted page whose runtime record is gone -- released as unrecoverable, or created by a
   * build that kept its records in memory only -- still leaves a row every paired device can see,
   * and every close path below is keyed on a live guest this runtime does not have. Without this
   * the row's X fails closed and the ghost outlives the browser it named.
   */
  private retireGhostBrowserSessionRow(
    worktreeId: string | undefined,
    browserPageId: string
  ): boolean {
    return (
      worktreeId !== undefined &&
      this.host.retireRuntimeOwnedBrowserSessionTab?.(worktreeId, browserPageId) === true
    )
  }

  private hasLiveRegisteredBrowserTab(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined
  ): boolean {
    for (const [, webContentsId] of bridge.getRegisteredTabs(worktreeId)) {
      const guest = webContents.fromId(webContentsId)
      if (guest && !guest.isDestroyed()) {
        return true
      }
    }
    return false
  }

  private hasLiveRegisteredBrowserPage(
    bridge: AgentBrowserBridge,
    worktreeId: string | undefined,
    browserPageId: string
  ): boolean {
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(browserPageId)
    if (webContentsId == null) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    return Boolean(guest && !guest.isDestroyed())
  }

  // Why: the CLI sends selectors (e.g. "path:/...") but the bridge keys tabs by "repoId::path"; resolve to that store-compatible id.
  private async resolveBrowserWorktreeId(selector?: string): Promise<string | undefined> {
    if (!selector) {
      // Why: after restart, webviews mount only when the pane is visible; activate the view so persisted tabs become operable via registerGuest.
      const bridge = this.host.getAgentBrowserBridge()
      if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, undefined)) {
        try {
          await this.ensureBrowserWorktreeActive(undefined)
        } catch {
          // Window may not exist yet (e.g. during startup or in tests)
        }
      }
      return undefined
    }

    const worktreeId = (await this.host.resolveWorktreeSelector(selector)).id
    // Why: explicit selectors are user intent, so resolution errors surface (not silently widen scope); only activation stays best-effort.
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserTab(bridge, worktreeId)) {
      try {
        await this.ensureBrowserWorktreeActive(worktreeId)
      } catch {
        // Fall through with the validated worktree id so routing stays scoped to the caller's explicit selector.
      }
    }
    return worktreeId
  }

  private async resolveBrowserCommandTarget(
    params: BrowserCommandTargetParams
  ): Promise<ResolvedBrowserCommandTarget> {
    const browserPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : undefined
    if (!browserPageId) {
      return {
        worktreeId: await this.resolveBrowserWorktreeId(params.worktree)
      }
    }

    const worktreeId = params.worktree
      ? (await this.host.resolveWorktreeSelector(params.worktree)).id
      : undefined
    const bridge = this.host.getAgentBrowserBridge()
    if (bridge && !this.hasLiveRegisteredBrowserPage(bridge, worktreeId, browserPageId)) {
      try {
        await this.ensureBrowserPageActive(worktreeId, browserPageId)
      } catch {
        // Fall through with the explicit page target; downstream routing surfaces a clear "tab not found" error if wake fails.
      }
    }
    return {
      // Why: an explicit browserPageId is already a stable tab identity, so don't auto-resolve cwd worktree scoping on top of it.
      worktreeId,
      browserPageId
    }
  }

  private resolveBrowserPageWebContents(
    worktreeId: string | undefined,
    browserPageId: string | undefined
  ): ResolvedBrowserPageWebContents {
    const bridge = this.requireAgentBrowserBridge()
    const resolvedPageId = browserPageId ?? bridge.getActivePageId(worktreeId)
    if (!resolvedPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const webContentsId = bridge.getRegisteredTabs(worktreeId).get(resolvedPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} was not found${scope}`
      )
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${resolvedPageId} is no longer available`
      )
    }
    return { browserPageId: resolvedPageId, webContents: guest }
  }

  // Why: background-mount the worktree via a hidden visibility lease so the webview guest can register without stealing the user's visible pane.
  private async ensureBrowserWorktreeActive(worktreeId: string | undefined): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send('browser:activateView', worktreeId ? { worktreeId } : {})
    // Why: the pane is operable only after the webview mounts and calls registerGuest; wait on that IPC rather than a flaky fixed sleep.
    await waitForWorktreeTabRegistration(worktreeId)
  }

  private async ensureBrowserPageActive(
    worktreeId: string | undefined,
    browserPageId: string
  ): Promise<void> {
    const win = this.host.getAuthoritativeWindow()
    win.webContents.send(
      'browser:activateView',
      worktreeId ? { worktreeId, browserPageId } : { browserPageId }
    )
    await waitForTabRegistration(browserPageId)
  }

  // Why: helper-driven clicks can bypass Electron navigation events; push authoritative URL/title updates after automation.
  private notifyRendererNavigation(browserPageId: string, url: string, title: string): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:navigation-update', { browserPageId, url, title })
    } catch {
      // Window may not exist during shutdown
    }
  }

  // Why: carry worktreeId (not a global setActiveWorktree) so one agent's --focus can't steal the screen from another agent's parallel worktree.
  private notifyRendererBrowserPaneFocus(
    worktreeId: string | undefined,
    browserPageId: string
  ): void {
    try {
      const win = this.host.getAuthoritativeWindow()
      win.webContents.send('browser:pane-focus', {
        worktreeId: worktreeId ?? null,
        browserPageId
      })
    } catch {
      // Window may not exist during shutdown
    }
  }

  async browserSnapshot(params: BrowserCommandTargetParams): Promise<BrowserSnapshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().snapshot(target.worktreeId, target.browserPageId)
  }

  async browserClick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClickResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.click(params.element, target.worktreeId, target.browserPageId)
    // Why: clicks can trigger navigation, so push the tab's live URL/title to the renderer even when automation targeted a non-active page.
    const page = bridge.getPageInfo(target.worktreeId, target.browserPageId)
    if (page) {
      this.notifyRendererNavigation(page.browserPageId, page.url, page.title)
    }
    return result
  }

  async browserGoto(
    params: { url: string } & BrowserCommandTargetParams
  ): Promise<BrowserGotoResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.goto(params.url, target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    if (!this.host.getAvailableAuthoritativeWindow() && target.worktreeId) {
      this.host.notifyHeadlessBrowserSessionTabsChanged?.(target.worktreeId)
    }
    return result
  }

  async browserFill(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserFillResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fill(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserType(
    params: { input: string } & BrowserCommandTargetParams
  ): Promise<BrowserTypeResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().type(
      params.input,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelect(
    params: {
      element: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserSelectResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().select(
      params.element,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserScroll(
    params: { direction: 'up' | 'down'; amount?: number } & BrowserCommandTargetParams
  ): Promise<BrowserScrollResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scroll(
      params.direction,
      params.amount,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserBack(params: BrowserCommandTargetParams): Promise<BrowserBackResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.back(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserReload(params: BrowserCommandTargetParams): Promise<BrowserReloadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const bridge = this.requireAgentBrowserBridge()
    const result = await bridge.reload(target.worktreeId, target.browserPageId)
    const pageId = bridge.getActivePageId(target.worktreeId, target.browserPageId)
    if (pageId) {
      this.notifyRendererNavigation(pageId, result.url, result.title)
    }
    return result
  }

  async browserScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().screenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  // The single leave path: an explicit stop, a ghost eviction and a same-device replacement all
  // unwind through here, so viewport hand-off, budget release and stream teardown cannot drift.
  private leaveScreencastSubscriber(
    active: ActiveBrowserScreencastPage,
    subscriptionId: string,
    session: BrowserScreencastSession
  ): void {
    const subscriber = active.subscribers.get(subscriptionId)
    if (!subscriber) {
      return
    }
    active.subscribers.delete(subscriptionId)
    subscriber.resolveDone()
    if (active.viewportOwnerSubscriptionId === subscriptionId) {
      const fallback = Array.from(active.subscribers.entries()).findLast(([, candidate]) =>
        hasScreencastViewportSize(candidate.viewport)
      )
      active.viewportOwnerSubscriptionId = fallback?.[0] ?? null
      if (fallback) {
        void session.updateViewport(fallback[1].viewport).catch(() => {})
      }
    }
    if (active.subscribers.size === 0) {
      active.stopping = true
      session.stop()
      return
    }
    // Why: a departed subscriber's caps would otherwise pin the shared stream for
    // the rest of its life, long after the client that asked for them is gone.
    void applySharedScreencastFrameBudget(active, session).catch(() => {})
  }

  async browserScreencast(
    params: BrowserScreencastParams,
    stream: {
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean | void
      emit?: (event: BrowserScreencastResult) => void
      pairedDeviceId?: string
    }
  ): Promise<BrowserScreencastStartResult> {
    if (await this.resolveClientHostedBrowserPage(params)) {
      throw new BrowserError(
        'browser_error',
        'Client-hosted browser pages do not support server screencast.'
      )
    }
    const target = await this.resolveBrowserCommandTarget(params)
    const { browserPageId, webContents: guest } = this.resolveBrowserPageWebContents(
      target.worktreeId,
      target.browserPageId
    )
    const subscriptionId = `browser-screencast:${browserPageId}:${randomUUID()}`
    const viewport = normalizeScreencastViewport(params)
    const budget = normalizeScreencastFrameBudget(params)
    let resolveSubscriberDone!: () => void
    const subscriberDone = new Promise<void>((resolve) => {
      resolveSubscriberDone = resolve
    })
    let createdPageStream = false
    let active = this.activeScreencastsByPageId.get(browserPageId)
    while (active?.stopping) {
      await active.session?.done
      active = this.activeScreencastsByPageId.get(browserPageId)
    }
    if (!active) {
      createdPageStream = true
      const subscribers = new Map<string, ActiveBrowserScreencastSubscriber>()
      const record = {
        format: params.format,
        session: null,
        stopping: false,
        subscribers,
        viewportOwnerSubscriptionId: null,
        appliedBudget: budget
      } as ActiveBrowserScreencastPage
      record.started = startBrowserScreencast(guest, {
        format: params.format,
        ...budget,
        ...viewport,
        onFrame: (bytes) => {
          const ghosts: string[] = []
          for (const [subscriptionId, subscriber] of record.subscribers) {
            // A slow viewer drops this frame without stalling every other viewer, but the
            // newest refusal is retained so a gate that opens later can still be filled.
            const delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
            subscriber.pendingFrame = delivered ? null : bytes
            subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
            if (screencastSubscriberIsGhost(subscriber.delivery)) {
              ghosts.push(subscriptionId)
            }
          }
          // Evicting after the fan-out keeps a teardown that stops the session from cutting the
          // remaining viewers out of this frame.
          for (const subscriptionId of ghosts) {
            if (record.session) {
              this.leaveScreencastSubscriber(record, subscriptionId, record.session)
            }
          }
          return true
        },
        onEvent: (event) => {
          for (const subscriber of record.subscribers.values()) {
            subscriber.emit?.(event)
          }
        },
        onError: (message) => {
          for (const subscriber of record.subscribers.values()) {
            subscriber.emit?.({ type: 'error', message })
          }
        }
      })
      active = record
      this.activeScreencastsByPageId.set(browserPageId, record)
      void record.started
        .then((session) => {
          record.session = session
          return session.done
        })
        .finally(() => {
          if (this.activeScreencastsByPageId.get(browserPageId) === record) {
            this.activeScreencastsByPageId.delete(browserPageId)
          }
          for (const subscriber of record.subscribers.values()) {
            subscriber.resolveDone()
          }
          record.subscribers.clear()
        })
        .catch(() => {})
    }
    active.subscribers.set(subscriptionId, {
      sendBinary: stream.sendBinary,
      emit: stream.emit,
      done: subscriberDone,
      resolveDone: resolveSubscriberDone,
      viewport,
      budget,
      pendingFrame: null,
      pairedDeviceId: stream.pairedDeviceId,
      delivery: INITIAL_SCREENCAST_SUBSCRIBER_DELIVERY
    })
    // Why: normalizeScreencastViewport keeps undefined dimensions, so a sizeless
    // subscriber taking ownership would clear the emulation for every viewer.
    if (hasScreencastViewportSize(viewport)) {
      active.viewportOwnerSubscriptionId = subscriptionId
    }
    let session: BrowserScreencastSession
    try {
      session = await active.started
    } catch (error) {
      active.subscribers.delete(subscriptionId)
      resolveSubscriberDone()
      throw error
    }
    // Why: a device that force-quit and reconnected arrives on a fresh socket, so the
    // connection-keyed replacement upstream cannot see its old subscription. Run this after the
    // joiner is registered — the page then never empties mid-replacement and stops the stream.
    if (stream.pairedDeviceId !== undefined) {
      // Deleting the entry being visited is well defined for a Map, and no other entry is touched.
      for (const [candidateId, candidate] of active.subscribers) {
        if (candidateId !== subscriptionId && candidate.pairedDeviceId === stream.pairedDeviceId) {
          this.leaveScreencastSubscriber(active, candidateId, session)
        }
      }
    }
    if (!createdPageStream) {
      if (active.viewportOwnerSubscriptionId === subscriptionId) {
        await session.updateViewport(viewport)
      }
      await applySharedScreencastFrameBudget(active, session)
    }
    return {
      subscriptionId,
      flushPendingFrame: () => {
        const subscriber = active.subscribers.get(subscriptionId)
        const bytes = subscriber?.pendingFrame
        if (!subscriber || !bytes) {
          return
        }
        const delivered = sendRemoteBrowserScreencastFrame(subscriber.sendBinary, bytes)
        subscriber.pendingFrame = delivered ? null : bytes
        // The replay is this subscriber's first chance to reach its socket, so it is also where
        // an eviction-eligible delivery history starts.
        subscriber.delivery = recordScreencastSubscriberSend(subscriber.delivery, delivered)
      },
      session: {
        done: subscriberDone,
        stop: () => this.leaveScreencastSubscriber(active, subscriptionId, session),
        updateViewport: session.updateViewport
      },
      ready: {
        type: 'ready',
        subscriptionId,
        browserPageId,
        format: active.format,
        tab: this.describeBrowserTab(browserPageId, target.worktreeId)
      }
    }
  }

  async browserEval(
    params: { expression: string } & BrowserCommandTargetParams
  ): Promise<BrowserEvalResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().evaluate(
      params.expression,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabList(params: { worktree?: string }): Promise<BrowserTabListResult> {
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    const clientPages = this.host.getRuntimeBrowserPageRegistry().listPages(workspaceId)
    let bridgeWorktreeId = workspaceId
    if (this.host.getAgentBrowserBridge()) {
      try {
        bridgeWorktreeId = await this.resolveBrowserWorktreeId(params.worktree)
      } catch (error) {
        if (clientPages.length === 0) {
          throw error
        }
      }
    }
    return { tabs: this.listLogicalBrowserTabs(bridgeWorktreeId, clientPages) }
  }

  async browserProceedCertificate(
    params: { challengeId: string } & BrowserCommandTargetParams
  ): Promise<BrowserCertificateProceedResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    if (!target.browserPageId) {
      return { ok: false, reason: 'missing' }
    }
    return browserCertificateTrustController.proceed(target.browserPageId, params.challengeId)
  }

  async browserTabShow(params: { page: string; worktree?: string }): Promise<BrowserTabShowResult> {
    const clientPage = this.host.getRuntimeBrowserPageRegistry().getPage(params.page)
    if (clientPage) {
      await this.assertClientPageWorkspace(clientPage, params.worktree)
      const tab = this.listLogicalBrowserTabs(
        clientPage.workspaceId,
        this.host.getRuntimeBrowserPageRegistry().listPages(clientPage.workspaceId)
      ).find((candidate) => candidate.browserPageId === clientPage.browserPageId)
      if (!tab) {
        throw new BrowserError('browser_tab_not_found', `Browser page ${params.page} was not found`)
      }
      return { tab }
    }
    const target = await this.resolveBrowserCommandTarget(params)
    return { tab: this.describeBrowserTab(params.page, target.worktreeId) }
  }

  async browserTabCurrent(params: { worktree?: string }): Promise<BrowserTabCurrentResult> {
    const tab = (await this.browserTabList(params)).tabs.find((candidate) => candidate.active)
    if (!tab) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    return { tab }
  }

  async browserTabSwitch(
    params: {
      index?: number
      focus?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSwitchResult> {
    const listed = await this.browserTabList({ worktree: params.worktree })
    const switchedIndex = params.page
      ? listed.tabs.findIndex((tab) => tab.browserPageId === params.page)
      : (params.index ?? -1)
    const selected = listed.tabs[switchedIndex]
    if (!selected) {
      const label = params.page ? `Browser page ${params.page}` : `Tab index ${params.index}`
      throw new BrowserError(
        'browser_tab_not_found',
        `${label} out of range (0-${listed.tabs.length - 1})`
      )
    }
    const clientPage = this.host.getRuntimeBrowserPageRegistry().getPage(selected.browserPageId)
    if (clientPage) {
      this.host
        .getRuntimeBrowserPageRegistry()
        .activatePage(clientPage.browserPageId, clientPage.placement)
      publishSwitchedBrowserSessionTab(this.host, {
        placementKind: 'client',
        browserPageId: clientPage.browserPageId,
        worktreeId: clientPage.workspaceId,
        focus: params.focus
      })
      return { switched: switchedIndex, browserPageId: clientPage.browserPageId }
    }
    const bridge = this.requireAgentBrowserBridge()
    const worktreeId =
      typeof selected.worktreeId === 'string'
        ? selected.worktreeId
        : params.worktree
          ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
          : undefined
    const result = await bridge.tabSwitch(undefined, worktreeId, selected.browserPageId)
    this.host.getRuntimeBrowserPageRegistry().deactivateGlobal()
    if (worktreeId) {
      this.host.getRuntimeBrowserPageRegistry().deactivateWorkspace(worktreeId)
    }
    // Why: scope focus to the tab's owning worktree; the renderer never yanks the user across worktrees on this signal (see focusBrowserTabInWorktree).
    const focusWorktreeId =
      worktreeId ?? browserManager.getWorktreeIdForTab(result.browserPageId) ?? undefined
    publishSwitchedBrowserSessionTab(this.host, {
      placementKind: 'bridge',
      browserPageId: result.browserPageId,
      worktreeId: focusWorktreeId,
      focus: params.focus
    })
    if (params.focus) {
      this.notifyRendererBrowserPaneFocus(focusWorktreeId, result.browserPageId)
    }
    return { ...result, switched: switchedIndex }
  }

  async browserHover(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserHoverResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().hover(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDrag(
    params: {
      from: string
      to: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserDragResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().drag(
      params.from,
      params.to,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserUpload(
    params: { element: string; files: string[] } & BrowserCommandTargetParams
  ): Promise<BrowserUploadResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().upload(
      params.element,
      params.files,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserWait(
    params: {
      selector?: string
      timeout?: number
      text?: string
      url?: string
      load?: string
      fn?: string
      state?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserWaitResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const { worktree: _, page: __, ...options } = params
    return this.requireAgentBrowserBridge().wait(options, target.worktreeId, target.browserPageId)
  }

  async browserCheck(
    params: { element: string; checked: boolean } & BrowserCommandTargetParams
  ): Promise<BrowserCheckResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().check(
      params.element,
      params.checked,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserFocus(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserFocusResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().focus(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserClear(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserClearResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clear(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSelectAll(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<BrowserSelectAllResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().selectAll(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserKeypress(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<BrowserKeypressResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keypress(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserPdf(params: BrowserCommandTargetParams): Promise<BrowserPdfResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().pdf(target.worktreeId, target.browserPageId)
  }

  async browserFullScreenshot(
    params: {
      format?: 'png' | 'jpeg'
    } & BrowserCommandTargetParams
  ): Promise<BrowserScreenshotResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().fullPageScreenshot(
      params.format,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Cookie management ──

  async browserCookieGet(
    params: { url?: string } & BrowserCommandTargetParams
  ): Promise<BrowserCookieGetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieGet(
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieSet(
    params: {
      name: string
      value: string
      domain?: string
      path?: string
      secure?: boolean
      httpOnly?: boolean
      sameSite?: string
      expires?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieSetResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieSet(
      params,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserCookieDelete(
    params: {
      name: string
      domain?: string
      url?: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserCookieDeleteResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().cookieDelete(
      params.name,
      params.domain,
      params.url,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Viewport ──

  async browserSetViewport(
    params: {
      width: number
      height: number
      deviceScaleFactor?: number
      mobile?: boolean
    } & BrowserCommandTargetParams
  ): Promise<BrowserViewportResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setViewport(
      params.width,
      params.height,
      params.deviceScaleFactor,
      params.mobile,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Geolocation ──

  async browserSetGeolocation(
    params: {
      latitude: number
      longitude: number
      accuracy?: number
    } & BrowserCommandTargetParams
  ): Promise<BrowserGeolocationResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setGeolocation(
      params.latitude,
      params.longitude,
      params.accuracy,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Request interception ──

  async browserInterceptEnable(
    params: {
      patterns?: string[]
    } & BrowserCommandTargetParams
  ): Promise<BrowserInterceptEnableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptEnable(
      params.patterns,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptDisable(
    params: BrowserCommandTargetParams
  ): Promise<BrowserInterceptDisableResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptDisable(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserInterceptList(params: BrowserCommandTargetParams): Promise<{ requests: unknown[] }> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().interceptList(target.worktreeId, target.browserPageId)
  }

  // ── Console/network capture ──

  async browserCaptureStart(
    params: BrowserCommandTargetParams
  ): Promise<BrowserCaptureStartResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStart(target.worktreeId, target.browserPageId)
  }

  async browserCaptureStop(params: BrowserCommandTargetParams): Promise<BrowserCaptureStopResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().captureStop(target.worktreeId, target.browserPageId)
  }

  async browserConsoleLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserConsoleResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().consoleLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserNetworkLog(
    params: { limit?: number } & BrowserCommandTargetParams
  ): Promise<BrowserNetworkLogResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().networkLog(
      params.limit,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Additional core commands ──

  async browserDblclick(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dblclick(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserForward(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().forward(target.worktreeId, target.browserPageId)
  }

  async browserScrollIntoView(
    params: { element: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().scrollIntoView(
      params.element,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserGet(
    params: {
      what: string
      selector?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().get(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserIs(
    params: { what: string; selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().is(
      params.what,
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Keyboard insert text ──

  async browserKeyboardInsertText(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().keyboardInsertText(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Mouse commands ──

  async browserMouseMove(
    params: { x: number; y: number } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseMove(
      params.x,
      params.y,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseDown(
    params: { button?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseDown(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseClick(
    params: {
      x: number
      y: number
      button?: string
      radius?: number
      modifiers?: ('cmd' | 'ctrl' | 'alt' | 'shift')[]
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseClick(
      params.x,
      params.y,
      params.button,
      target.worktreeId,
      target.browserPageId,
      clampOptionalNumber(params.radius, 0, 64),
      params.modifiers
    )
  }

  async browserMouseUp(params: { button?: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseUp(
      params.button,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserMouseWheel(
    params: {
      dy: number
      dx?: number
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().mouseWheel(
      params.dy,
      params.dx,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Find (semantic locators) ──

  async browserFind(
    params: {
      locator: string
      value: string
      action: string
      text?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().find(
      params.locator,
      params.value,
      params.action,
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Set commands ──

  async browserSetDevice(params: { name: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setDevice(
      params.name,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetOffline(
    params: { state?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setOffline(
      params.state,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetHeaders(
    params: { headers: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setHeaders(
      params.headers,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetCredentials(
    params: {
      user: string
      pass: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setCredentials(
      params.user,
      params.pass,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserSetMedia(
    params: {
      colorScheme?: string
      reducedMotion?: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().setMedia(
      params.colorScheme,
      params.reducedMotion,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Clipboard commands ──

  async browserClipboardRead(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardRead(target.worktreeId, target.browserPageId)
  }

  async browserClipboardWrite(
    params: { text: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().clipboardWrite(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Dialog commands ──

  async browserDialogAccept(
    params: { text?: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogAccept(
      params.text,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserDialogDismiss(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().dialogDismiss(target.worktreeId, target.browserPageId)
  }

  // ── Storage commands ──

  async browserStorageLocalGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageLocalClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageLocalClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionGet(
    params: { key: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionGet(
      params.key,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionSet(
    params: {
      key: string
      value: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionSet(
      params.key,
      params.value,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserStorageSessionClear(params: BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().storageSessionClear(
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Download command ──

  async browserDownload(
    params: {
      selector: string
      path: string
    } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().download(
      params.selector,
      params.path,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── Highlight command ──

  async browserHighlight(
    params: { selector: string } & BrowserCommandTargetParams
  ): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().highlight(
      params.selector,
      target.worktreeId,
      target.browserPageId
    )
  }

  // ── New: exec passthrough + tab lifecycle ──

  async browserExec(params: { command: string } & BrowserCommandTargetParams): Promise<unknown> {
    const target = await this.resolveBrowserCommandTarget(params)
    return this.requireAgentBrowserBridge().exec(
      params.command,
      target.worktreeId,
      target.browserPageId
    )
  }

  async browserTabCreate(
    params: {
      url?: string
      worktree?: string
      page?: string
      profileId?: string
      waitForRegistration?: boolean
      activate?: boolean
      navigation?: RuntimeNavigationTarget
      targetGroupId?: string
      placement?: BrowserPageCreationPlacement
    },
    caller?: { pairedDeviceId?: string; clientKind?: 'mobile' | 'runtime' }
  ): Promise<{ browserPageId: string }> {
    const url = params.url ?? 'about:blank'
    const focus = resolveBrowserTabCreateFocus({
      activate: params.activate,
      navigation: params.navigation,
      clientKind: caller?.clientKind
    })
    const worktree = params.worktree
      ? params.placement?.kind === 'client'
        ? await this.host.resolveBrowserWorkspace(params.worktree)
        : await this.host.resolveWorktreeSelector(params.worktree)
      : undefined
    const worktreeId = worktree?.id
    const sessionPartition = browserSessionRegistry.resolveKnownPartition(params.profileId)
    if (!sessionPartition) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    if (params.placement?.kind === 'client') {
      if (!caller?.pairedDeviceId) {
        throw new BrowserError(
          'forbidden',
          'Client-hosted browser pages require an authenticated paired runtime.'
        )
      }
      if (!worktree) {
        throw new BrowserError(
          'invalid_argument',
          'Client-hosted browser pages require an explicit workspace.'
        )
      }
      const browserPageId = params.page ?? randomUUID()
      const executionHost = await this.host.resolveBrowserNetworkExecutionHost(worktree)
      const authority = this.host.getBrowserHostLeaseRegistry()
      const browserProfileId = params.profileId ?? browserSessionRegistry.getDefaultProfile().id
      const created = await createRuntimeBrowserClientPage(authority, {
        browserPageId,
        browserHostClientId: params.placement.browserHostClientId,
        pairedDeviceId: caller.pairedDeviceId,
        browserProfileId,
        executionHost,
        workspaceId: worktree.id
      })
      const pages = this.host.getRuntimeBrowserPageRegistry()
      pages.publishClientPage({
        browserPageId,
        workspaceId: worktree.id,
        browserProfileId,
        executionHostKey: browserNetworkExecutionHostKey(executionHost),
        placement: created.placement,
        pairedDeviceId: caller.pairedDeviceId,
        url: 'about:blank',
        loading: url !== 'about:blank',
        active: focus.startsActive
      })
      publishCreatedBrowserSessionTab(this.host, {
        placementKind: 'client',
        browserPageId,
        worktreeId: worktree.id,
        focus,
        clientNavigationId: caller.pairedDeviceId,
        targetGroupId: params.targetGroupId
      })
      if (url !== 'about:blank') {
        try {
          await navigateRuntimeBrowserClientPage(authority, {
            browserPageId,
            placement: created.placement,
            url
          })
          pages.updatePage(browserPageId, created.placement, { url, loading: false })
        } catch {
          pages.updatePage(browserPageId, created.placement, { loading: false })
        }
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktree.id)
      }
      return { browserPageId }
    }
    // Why: headless serve has no renderer <webview>, so back the page with a main-process offscreen WebContents instead.
    if (!this.host.getAvailableAuthoritativeWindow()) {
      const offscreen = this.host.getOffscreenBrowserBackend()
      if (!offscreen) {
        throw new BrowserError('browser_error', 'This host does not support browser panes.')
      }
      // Why: the offscreen backend registers synchronously, so there is no webview-mount wait.
      const created = await offscreen.createTab({
        url,
        worktreeId,
        profileId: params.profileId,
        ...(params.page ? { browserPageId: params.page } : {})
      })
      publishCreatedBrowserSessionTab(this.host, {
        placementKind: 'offscreen',
        browserPageId: created.browserPageId,
        worktreeId,
        focus,
        ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
        targetGroupId: params.targetGroupId
      })
      return { browserPageId: created.browserPageId }
    }
    const { browserPageId } = await this.createBrowserTabInRenderer(
      url,
      worktreeId,
      params.profileId,
      params.profileId ? sessionPartition : undefined,
      focus.focusesHost,
      params.page
    )

    // Why: the webview must mount and register before the tab is operable, so wait here (returning the ID anyway on timeout).
    if (params.waitForRegistration !== false) {
      try {
        await waitForTabRegistration(browserPageId)
      } catch {
        // Tab exists in the renderer even if the webview hasn't mounted; subsequent commands surface a clear error if it never loads.
      }
    }

    const bridge = this.requireAgentBrowserBridge()
    publishCreatedBrowserSessionTab(this.host, {
      placementKind: 'renderer',
      browserPageId,
      worktreeId,
      focus,
      ...(caller?.pairedDeviceId ? { clientNavigationId: caller.pairedDeviceId } : {}),
      targetGroupId: params.targetGroupId
    })

    // Why: the webview loads about:blank first; route navigation through the bridge so its registered owner remains authoritative.
    if (url && url !== 'about:blank') {
      const navigate = async (): Promise<void> => {
        const result = await bridge.goto(url, worktreeId, browserPageId)
        this.notifyRendererNavigation(browserPageId, result.url, result.title)
        if (!this.host.getAvailableAuthoritativeWindow() && worktreeId) {
          this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
        }
      }
      if (params.waitForRegistration === true) {
        void navigate().catch(() => {})
        return { browserPageId }
      }
      try {
        await navigate()
      } catch {
        // Tab exists but navigation failed — caller can retry with explicit goto
      }
    }

    return { browserPageId }
  }

  async browserTabSetProfile(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSetProfileResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const browserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    // Why: 'default' is a synthetic id; fall back to the registry's default profile when not registered.
    const profile =
      browserSessionRegistry.getProfile(params.profileId) ??
      (params.profileId === 'default' ? browserSessionRegistry.getDefaultProfile() : null)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }

    // Why: short-circuit no-op switches so the renderer doesn't needlessly tear down and remount the webview.
    const currentProfileId = browserManager.getSessionProfileIdForTab(browserPageId) ?? 'default'
    if (currentProfileId === profile.id) {
      return {
        browserPageId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    }

    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        reject(new Error('Tab profile update timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabSetProfileReply', handler)
      win.webContents.send('browser:requestTabSetProfile', {
        requestId,
        browserPageId,
        profileId: profile.id,
        sessionPartition: profile.partition
      })
    })

    // Why: profile change remounts the webview; wait for re-register so follow-up commands see the new profile and an attached guest.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Best-effort: re-register won't fire while the worktree is hidden; downstream commands retry once the pane re-mounts.
    }

    return {
      browserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserTabProfileShow(params: {
    page: string
    worktree?: string
  }): Promise<BrowserTabProfileShowResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const tab = this.describeBrowserTab(params.page, target.worktreeId)
    return {
      browserPageId: tab.browserPageId,
      worktreeId: tab.worktreeId ?? null,
      profileId: tab.profileId ?? null,
      profileLabel: tab.profileLabel ?? null
    }
  }

  async browserTabProfileClone(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabProfileCloneResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const sourceBrowserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!sourceBrowserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const sourceTab = this.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const created = await this.createBrowserTabInRenderer(
      sourceTab.url,
      sourceTab.worktreeId ?? target.worktreeId,
      profile.id,
      profile.partition
    )
    // Why: wait for the cloned tab's webview to register so the returned browserPageId is operable by the next CLI call.
    try {
      await waitForTabRegistration(created.browserPageId)
    } catch {
      // Best-effort: registration may not fire if the worktree is hidden.
    }
    return {
      browserPageId: created.browserPageId,
      sourceBrowserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserProfileList(): Promise<BrowserProfileListResult> {
    return { profiles: browserSessionRegistry.listProfiles() }
  }

  async browserProfileCreate(params: {
    label: string
    scope: 'isolated' | 'imported'
    userAgentMode?: BrowserSessionUserAgentMode
  }): Promise<BrowserProfileCreateResult> {
    return {
      profile: browserSessionRegistry.createProfile(params.scope, params.label, {
        userAgentMode: params.userAgentMode
      })
    }
  }

  async browserProfileDelete(params: { profileId: string }): Promise<BrowserProfileDeleteResult> {
    return {
      deleted: await browserSessionRegistry.deleteProfile(params.profileId),
      profileId: params.profileId
    }
  }

  async browserProfileDetectBrowsers(): Promise<BrowserDetectProfilesResult> {
    return {
      // Why: expose only display metadata; filesystem paths and keychain identifiers stay on the runtime server.
      browsers: detectInstalledBrowsers().map((browser) => ({
        family: browser.family,
        label: browser.label,
        profiles: browser.profiles,
        selectedProfile: browser.selectedProfile
      }))
    }
  }

  async browserProfileImportFromBrowser(params: {
    profileId: string
    browserFamily: string
    browserProfile?: string
    supportsPartitionSkippedCookies?: true
  }): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return { ok: false, reason: 'Session profile not found.' }
    }
    if (
      params.browserProfile &&
      (/[/\\]/.test(params.browserProfile) || params.browserProfile.includes('..'))
    ) {
      return { ok: false, reason: 'Invalid browser profile name.' }
    }

    const browsers = detectInstalledBrowsers()
    let browser = browsers.find((candidate) => candidate.family === params.browserFamily)
    if (!browser) {
      return { ok: false, reason: 'Browser not found on this system.' }
    }

    if (params.browserProfile && params.browserProfile !== browser.selectedProfile) {
      const reselected = selectBrowserProfile(browser, params.browserProfile)
      if (!reselected) {
        return {
          ok: false,
          reason: `No cookies database found for profile "${params.browserProfile}".`
        }
      }
      browser = reselected
    }

    const result = await importCookiesFromBrowser(browser, profile.partition, {
      canReportPartitionSkippedCookies: params.supportsPartitionSkippedCookies === true
    })
    if (!result.ok) {
      return result
    }

    const profileName =
      browser.profiles.find((candidate) => candidate.directory === browser.selectedProfile)?.name ??
      browser.selectedProfile
    browserSessionRegistry.updateProfileSource(params.profileId, {
      browserFamily: browser.family,
      profileName,
      importedAt: Date.now()
    })
    return { ...result, profileId: params.profileId }
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }

  async browserTabClose(params: {
    index?: number
    page?: string
    worktree?: string
  }): Promise<{ closed: boolean }> {
    const pages = this.host.getRuntimeBrowserPageRegistry()
    let clientPage = params.page ? pages.getPage(params.page) : undefined
    if (clientPage) {
      await this.assertClientPageWorkspace(clientPage, params.worktree)
    } else if (!params.page) {
      const workspaceId = params.worktree
        ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
        : undefined
      if (pages.listPages(workspaceId).length > 0) {
        const tab =
          params.index !== undefined
            ? (await this.browserTabList({ worktree: params.worktree })).tabs[params.index]
            : (await this.browserTabCurrent({ worktree: params.worktree })).tab
        clientPage = tab ? pages.getPage(tab.browserPageId) : undefined
      }
    }
    if (clientPage) {
      const authority = this.host.getBrowserHostLeaseRegistry()
      // Why: a retained page whose host quit has no placement left to command, and asking the
      // absent host first would refuse the close and strand the tab with no way to dismiss it.
      if (authority.getPlacement(clientPage.browserPageId)) {
        await closeRuntimeBrowserClientPage(authority, {
          browserPageId: clientPage.browserPageId,
          placement: clientPage.placement
        })
      }
      if (!pages.retirePage(clientPage.browserPageId, clientPage.placement)) {
        throw new Error('browser_page_placement_stale')
      }
      if (this.host.retireRuntimeOwnedBrowserSessionTab) {
        this.host.retireRuntimeOwnedBrowserSessionTab(
          clientPage.workspaceId,
          clientPage.browserPageId
        )
      } else {
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(clientPage.workspaceId)
      }
      return { closed: true }
    }
    const namedPageId =
      typeof params.page === 'string' && params.page.length > 0 ? params.page : null
    const explicitPage = namedPageId !== null
    const bridge = this.host.getAgentBrowserBridge()
    if (!bridge) {
      // Why before the refusal: a runtime with no browser session cannot be holding this page
      // either, but it can still be carrying the session row that names it.
      if (
        namedPageId &&
        params.worktree &&
        this.retireGhostBrowserSessionRow(
          (await this.host.resolveWorktreeSelector(params.worktree)).id,
          namedPageId
        )
      ) {
        return { closed: true }
      }
      throw new BrowserError('browser_no_tab', 'No browser session is active')
    }
    const worktreeId = explicitPage
      ? params.worktree
        ? (await this.host.resolveWorktreeSelector(params.worktree)).id
        : undefined
      : await this.resolveBrowserWorktreeId(params.worktree)

    let tabId: string | null = null
    if (namedPageId !== null) {
      tabId = namedPageId
    } else if (params.index !== undefined) {
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      if (params.index < 0 || params.index >= entries.length) {
        throw new Error(`Tab index ${params.index} out of range (0-${entries.length - 1})`)
      }
      tabId = entries[params.index][0]
    } else {
      // Why: try the bridge first; fall back to the renderer for tabs whose webview hasn't mounted yet (e.g. just created).
      const tabs = bridge.getRegisteredTabs(worktreeId)
      const entries = [...tabs.entries()]
      const activeEntry = entries.find(([, wcId]) => wcId === bridge.getActiveWebContentsId())
      if (activeEntry) {
        tabId = activeEntry[0]
      }
    }

    // Why: headless serve has no renderer to ask, so destroy the offscreen page directly.
    const authoritativeWindow = this.host.getAvailableAuthoritativeWindow()
    const offscreen = authoritativeWindow ? null : this.host.getOffscreenBrowserBackend()
    if (offscreen) {
      // Why: resolve the active page for implicit close so we don't report success while closing nothing.
      const resolvedTabId = tabId ?? bridge.getActivePageId(worktreeId)
      if (!resolvedTabId) {
        return { closed: false }
      }
      if (explicitPage && !bridge.getRegisteredTabs(worktreeId).has(resolvedTabId)) {
        if (this.retireGhostBrowserSessionRow(worktreeId, resolvedTabId)) {
          return { closed: true }
        }
        const scope = worktreeId ? ' in this worktree' : ''
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${resolvedTabId} was not found${scope}`
        )
      }
      await offscreen.closeTab(resolvedTabId)
      // Why: closeTab only destroys the guest; without retirement, paired clients keep a
      // dead session tab until an unrelated republish (closeMobileSessionTab already retires).
      if (worktreeId) {
        if (this.host.retireRuntimeOwnedBrowserSessionTab) {
          this.host.retireRuntimeOwnedBrowserSessionTab(worktreeId, resolvedTabId)
        } else {
          this.host.notifyHeadlessBrowserSessionTabsChanged?.(worktreeId)
        }
      }
      return { closed: true }
    }

    if (!authoritativeWindow && tabId && !bridge.getRegisteredTabs(worktreeId).has(tabId)) {
      if (this.retireGhostBrowserSessionRow(worktreeId, tabId)) {
        return { closed: true }
      }
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError('browser_tab_not_found', `Browser page ${tabId} was not found${scope}`)
    }

    const win = authoritativeWindow ?? this.host.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCloseReply', handler)
        reject(new Error('Tab close timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string; code?: 'browser_tab_not_found' }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCloseReply', handler)
        if (reply.error) {
          reject(
            reply.code === 'browser_tab_not_found'
              ? new BrowserError('browser_tab_not_found', reply.error)
              : new Error(reply.error)
          )
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabCloseReply', handler)
      // Why: pass worktreeId so the renderer scopes the close correctly instead of falling back to the globally active tab in the wrong worktree.
      win.webContents.send('browser:requestTabClose', { requestId, tabId, worktreeId })
    })

    return { closed: true }
  }

  private enrichBrowserTabInfo(
    tab: BrowserTabListResult['tabs'][number]
  ): BrowserTabListResult['tabs'][number] {
    const rawProfileId = browserManager.getSessionProfileIdForTab(tab.browserPageId)
    const profile =
      browserSessionRegistry.getProfile(rawProfileId ?? 'default') ??
      browserSessionRegistry.getDefaultProfile()
    return {
      ...tab,
      worktreeId: browserManager.getWorktreeIdForTab(tab.browserPageId) ?? null,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  private listLogicalBrowserTabs(
    worktreeId: string | undefined,
    clientPages: readonly RuntimeBrowserClientPage[]
  ): BrowserTabListResult['tabs'] {
    const clientPageActive = clientPages.some((page) => page.active)
    const bridge = this.host.getAgentBrowserBridge()
    const serverTabs =
      bridge && typeof bridge.tabList === 'function'
        ? bridge.tabList(worktreeId).tabs.map((tab) => ({
            ...this.enrichBrowserTabInfo(tab),
            active: clientPageActive ? false : tab.active
          }))
        : []
    const clientTabs = clientPages.map((page, offset) => {
      const profile =
        browserSessionRegistry.getProfile(page.browserProfileId) ??
        browserSessionRegistry.getDefaultProfile()
      return {
        browserPageId: page.browserPageId,
        index: serverTabs.length + offset,
        url: page.url,
        title: page.title,
        active: page.active,
        loadError: null,
        certificateFailure: null,
        worktreeId: page.workspaceId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    })
    const tabs = [...serverTabs, ...clientTabs]
    if (tabs.length > 0 && !tabs.some((tab) => tab.active)) {
      tabs[0] = { ...tabs[0]!, active: true }
    }
    return tabs.map((tab, index) => ({ ...tab, index }))
  }

  private async assertClientPageWorkspace(
    page: RuntimeBrowserClientPage,
    selector: string | undefined
  ): Promise<void> {
    if (!selector) {
      return
    }
    const workspace = await this.host.resolveBrowserWorkspace(selector)
    if (workspace.id !== page.workspaceId) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${page.browserPageId} was not found in this worktree`
      )
    }
  }

  private async resolveClientHostedBrowserPage(
    params: BrowserCommandTargetParams
  ): Promise<RuntimeBrowserClientPage | undefined> {
    const pages = this.host.getRuntimeBrowserPageRegistry()
    if (params.page) {
      const page = pages.getPage(params.page)
      if (page) {
        await this.assertClientPageWorkspace(page, params.worktree)
      }
      return page
    }
    const workspaceId = params.worktree
      ? (await this.host.resolveBrowserWorkspace(params.worktree)).id
      : undefined
    return pages.listPages(workspaceId).find((page) => page.active)
  }

  private describeBrowserTab(
    browserPageId: string,
    explicitWorktreeId?: string
  ): BrowserTabListResult['tabs'][number] {
    const worktreeId = explicitWorktreeId ?? browserManager.getWorktreeIdForTab(browserPageId)
    const tab = this.requireAgentBrowserBridge()
      .tabList(worktreeId)
      .tabs.find((entry) => entry.browserPageId === browserPageId)
    if (!tab) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }
    return this.enrichBrowserTabInfo(tab)
  }

  private async createBrowserTabInRenderer(
    url: string,
    worktreeId: string | undefined,
    profileId: string | undefined,
    sessionPartition: string | undefined,
    activate?: boolean,
    requestedPageId?: string
  ): Promise<{ browserPageId: string }> {
    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()

    const browserPageId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabCreateReply', handler)
        reject(new Error('Tab creation timed out'))
      }, 10_000)

      const handler = (
        event: Electron.IpcMainEvent,
        reply: { requestId: string; browserPageId?: string; error?: string }
      ): void => {
        if (event.sender !== win.webContents || reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabCreateReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve(reply.browserPageId!)
        }
      }
      ipcMain.on('browser:tabCreateReply', handler)
      win.webContents.send('browser:requestTabCreate', {
        requestId,
        url,
        worktreeId,
        ...(requestedPageId ? { browserPageId: requestedPageId } : {}),
        // Why: keep these undefined (not null) when no profile is chosen so the renderer still applies default-profile inheritance.
        sessionProfileId: profileId,
        sessionPartition,
        activate
      })
    })

    return { browserPageId }
  }
}
