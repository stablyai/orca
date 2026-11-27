import { BrowserError } from '../../../browser/browser-error'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import {
  setBrowserGrabMode,
  cancelBrowserGrabMode,
  isCurrentBrowserGrabRequest
} from '../../../browser/element-grab/browser-grab-mode-sequencer'
import { supersededGrabMode } from '../../../browser/element-grab/browser-grab-mode-admission'
import { watchBrowserGuestDocument } from '../../../browser/element-grab/watch-browser-guest-document'
import type { BrowserGuestDocumentEvent } from '../../../../shared/browser/annotations/browser-guest-document-event'
import type {
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverResult,
  BrowserSetGrabModeResult
} from '../../../../shared/browser/element-grab/browser-grab-types'
import type { BrowserAnnotationViewportBridgeMarker } from '../../../../shared/browser/annotations/browser-annotation-viewport-bridge'
import type { BrowserCommandTargetParams } from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabCatalog } from '../tabs/browser-tab-catalog'
import {
  PageAdmissionCancelledError,
  setPageAdmissionSignal
} from './browser-page-admission-cancel'

type ResolvedGrabGuest = { browserPageId: string; resolveGuest: () => Electron.WebContents | null }
/** Cancelling aborts the enable's own wait for page admission, which releases its page claim. */
type PendingGrabEnable = { cancelled: boolean; admission: AbortController }
// Viewers hold at most a few enables each; the cap only bounds a misbehaving client.
const MAX_PENDING_GRAB_ENABLES = 64

/** The addressed operation: the same request ID on another page or workspace is another request. */
function pendingEnableKey(
  params: BrowserCommandTargetParams & { requestId?: string }
): string | null {
  return params.requestId === undefined
    ? null
    : JSON.stringify([params.page ?? null, params.worktree ?? null, params.requestId])
}

/** The element picker for viewers of a page this host renders; the same guest code local panes drive over IPC. */
export class RuntimeBrowserGrab {
  /** Request-bound enables still waiting for page admission, keyed by page and request. */
  private readonly pendingEnables = new Map<string, PendingGrabEnable>()

  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'resolveBrowserCommandTarget' | 'resolveBrowserPageWebContents'
    >,
    private readonly catalog: Pick<RuntimeBrowserTabCatalog, 'resolveClientHostedBrowserPage'>
  ) {}

  /** Passive lookups never wake, mount or wait on a page; a dormant page resolves no guest. */
  private async resolveGrabGuest(
    params: BrowserCommandTargetParams,
    passive = false
  ): Promise<ResolvedGrabGuest> {
    if (await this.catalog.resolveClientHostedBrowserPage(params)) {
      throw new BrowserError(
        'browser_error',
        'Client-hosted browser pages run element selection on the desktop that draws them.'
      )
    }
    const target = await this.targets.resolveBrowserCommandTarget(params, { passive })
    let browserPageId: string
    try {
      browserPageId = this.targets.resolveBrowserPageWebContents(
        target.worktreeId,
        target.browserPageId
      ).browserPageId
    } catch (error) {
      if (!passive || !target.browserPageId) {
        throw error
      }
      browserPageId = target.browserPageId
    }
    // Queued operations re-resolve: the page may close or swap guests while one waits.
    const resolveGuest = (): Electron.WebContents | null => {
      try {
        return this.targets.resolveBrowserPageWebContents(target.worktreeId, browserPageId)
          .webContents
      } catch {
        return null
      }
    }
    return { browserPageId, resolveGuest }
  }

  /**
   * Holds an enable's cancellation from before page admission until the sequencer owns the
   * request: until then a cancel finds no owner there, and the enable must not arm after it.
   */
  async admitGrabSetMode(
    params: BrowserCommandTargetParams & { enabled: boolean; requestId?: string },
    run: () => Promise<BrowserSetGrabModeResult>
  ): Promise<BrowserSetGrabModeResult> {
    const key = pendingEnableKey(params)
    if (!params.enabled || key === null) {
      return run()
    }
    // A repeat of a request still waiting would slip past the one cancel that request gets.
    if (this.pendingEnables.has(key)) {
      return supersededGrabMode()
    }
    if (this.pendingEnables.size >= MAX_PENDING_GRAB_ENABLES) {
      return supersededGrabMode()
    }
    const pending: PendingGrabEnable = { cancelled: false, admission: new AbortController() }
    this.pendingEnables.set(key, pending)
    setPageAdmissionSignal(params, pending.admission.signal)
    try {
      return await run()
    } catch (error) {
      // Cancelled while waiting for its page: settle now so the viewer's later input is not held.
      if (pending.cancelled && error instanceof PageAdmissionCancelledError) {
        return supersededGrabMode()
      }
      throw error
    } finally {
      if (this.pendingEnables.get(key) === pending) {
        this.pendingEnables.delete(key)
      }
    }
  }

  async browserGrabSetMode(
    params: BrowserCommandTargetParams & { enabled: boolean; requestId?: string },
    signal?: AbortSignal
  ): Promise<BrowserSetGrabModeResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    const key = pendingEnableKey(params)
    const pending = key === null ? undefined : this.pendingEnables.get(key)
    if (pending?.cancelled) {
      return supersededGrabMode()
    }
    // From here the sequencer owns the request (it registers synchronously), so cancel goes there.
    if (key !== null && pending && this.pendingEnables.get(key) === pending) {
      this.pendingEnables.delete(key)
    }
    const result = await setBrowserGrabMode(
      browserPageId,
      params.enabled,
      resolveGuest,
      undefined,
      {
        requestId: params.requestId
      }
    )
    // A viewer that disconnected before its await arrives would leave the page's clicks blocked by a picker
    // with no wait and no timeout.
    if (params.enabled && signal?.aborted) {
      cancelBrowserGrabMode(browserPageId, resolveGuest, params.requestId, 'runtime')
      return supersededGrabMode()
    }
    return result
  }

  async browserGrabAwait(
    params: BrowserCommandTargetParams & { opId: string; requestId?: string },
    signal?: AbortSignal
  ): Promise<BrowserGrabResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    // A viewer that disconnects or gives up must not leave the page armed until the grab times out.
    const abandon = (): void => {
      cancelBrowserGrabMode(browserPageId, resolveGuest, params.requestId, 'runtime')
    }
    // Also when it gave up while the page was being resolved: nothing else retires the armed picker.
    if (signal?.aborted) {
      abandon()
      return { opId: params.opId, kind: 'cancelled', reason: 'user' }
    }
    const guest = resolveGuest()
    if (!guest) {
      return { opId: params.opId, kind: 'error', reason: 'Guest not ready' }
    }
    if (!isCurrentBrowserGrabRequest(browserPageId, guest, params.requestId, 'runtime')) {
      return { opId: params.opId, kind: 'cancelled', reason: 'navigation' }
    }
    signal?.addEventListener('abort', abandon, { once: true })
    try {
      return await browserManager.awaitGrabSelection(browserPageId, params.opId, guest)
    } finally {
      signal?.removeEventListener('abort', abandon)
    }
  }

  async browserGrabCancel(
    params: BrowserCommandTargetParams & { requestId?: string }
  ): Promise<{ cancelled: boolean }> {
    // An enable still waiting for its page has no sequencer owner yet; it must not arm after this.
    const key = pendingEnableKey(params)
    const pending = key === null ? undefined : this.pendingEnables.get(key)
    if (pending) {
      pending.cancelled = true
      // Stop its wait for the page; the page's own load continues for anyone else.
      pending.admission.abort()
      return { cancelled: true }
    }
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params, true)
    return {
      cancelled: cancelBrowserGrabMode(browserPageId, resolveGuest, params.requestId, 'runtime')
    }
  }

  async browserGrabPickedPresent(
    params: BrowserCommandTargetParams & { selectionId: string; interactive?: boolean }
  ): Promise<boolean | null> {
    let resolved: ResolvedGrabGuest
    try {
      resolved = await this.resolveGrabGuest(params, true)
    } catch {
      return null
    }
    const { resolveGuest } = resolved
    const guest = resolveGuest()
    return guest
      ? browserManager.isGrabPickedElementPresent(
          params.selectionId,
          guest,
          params.interactive === true
        )
      : null
  }

  async browserGrabCaptureSelection(
    params: BrowserCommandTargetParams & { rect: BrowserGrabRect; selectionId: string }
  ): Promise<BrowserCaptureSelectionScreenshotResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    const guest = resolveGuest()
    if (!guest) {
      return { ok: false, reason: 'Guest not ready' }
    }
    const screenshot = await browserManager.captureSelectionScreenshot(
      browserPageId,
      params.rect,
      params.selectionId,
      guest
    )
    return screenshot
      ? { ok: true, screenshot }
      : { ok: false, reason: 'Screenshot capture failed' }
  }

  async browserGrabExtractHover(
    params: BrowserCommandTargetParams
  ): Promise<BrowserExtractHoverResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    const guest = resolveGuest()
    if (!guest) {
      return { ok: false, reason: 'Guest not ready' }
    }
    const payload = await browserManager.extractHoverPayload(browserPageId, guest)
    return payload ? { ok: true, payload } : { ok: false, reason: 'No element hovered' }
  }

  async browserGrabViewportBridge(
    params: BrowserCommandTargetParams & {
      enabled: boolean
      emitViewport: boolean
      markers: BrowserAnnotationViewportBridgeMarker[]
      selectionId?: string
      token: string
    }
  ): Promise<{ applied: boolean }> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    const applied = await browserManager.setAnnotationViewportBridge(
      browserPageId,
      {
        enabled: params.enabled,
        // Reports reach the viewer through browserGrabWatch.
        emitViewport: params.emitViewport,
        markers: params.markers,
        selectionId: params.selectionId,
        token: params.token
      },
      resolveGuest
    )
    return { applied }
  }

  /** The guest events a local webview would give its pane, for a viewer of a page drawn here. */
  async browserGrabWatch(
    params: BrowserCommandTargetParams,
    emit: (event: BrowserGuestDocumentEvent) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const { resolveGuest } = await this.resolveGrabGuest(params)
    const guest = resolveGuest()
    if (!guest) {
      throw new BrowserError('browser_tab_not_found', 'Browser page is no longer available')
    }
    await watchBrowserGuestDocument(guest, emit, signal)
  }
}
