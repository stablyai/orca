import { BrowserError } from '../../../browser/browser-error'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import {
  setBrowserGrabMode,
  cancelBrowserGrabMode,
  isCurrentBrowserGrabRequest
} from '../../../browser/element-grab/browser-grab-mode-sequencer'
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

type ResolvedGrabGuest = { browserPageId: string; resolveGuest: () => Electron.WebContents | null }

/** The element picker for viewers of a page this host renders; the same guest code local panes drive over IPC. */
export class RuntimeBrowserGrab {
  constructor(
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'resolveBrowserCommandTarget' | 'resolveBrowserPageWebContents'
    >,
    private readonly catalog: Pick<RuntimeBrowserTabCatalog, 'resolveClientHostedBrowserPage'>
  ) {}

  private async resolveGrabGuest(params: BrowserCommandTargetParams): Promise<ResolvedGrabGuest> {
    if (await this.catalog.resolveClientHostedBrowserPage(params)) {
      throw new BrowserError(
        'browser_error',
        'Client-hosted browser pages run element selection on the desktop that draws them.'
      )
    }
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const { browserPageId } = this.targets.resolveBrowserPageWebContents(
      target.worktreeId,
      target.browserPageId
    )
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

  async browserGrabSetMode(
    params: BrowserCommandTargetParams & { enabled: boolean; requestId?: string }
  ): Promise<BrowserSetGrabModeResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    return setBrowserGrabMode(browserPageId, params.enabled, resolveGuest, undefined, {
      requestId: params.requestId
    })
  }

  async browserGrabAwait(
    params: BrowserCommandTargetParams & { opId: string; requestId?: string },
    signal?: AbortSignal
  ): Promise<BrowserGrabResult> {
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    const guest = resolveGuest()
    if (!guest) {
      return { opId: params.opId, kind: 'error', reason: 'Guest not ready' }
    }
    if (!isCurrentBrowserGrabRequest(browserPageId, guest, params.requestId, 'runtime'))
      return { opId: params.opId, kind: 'cancelled', reason: 'navigation' }
    // A viewer that disconnects or gives up must not leave the page armed until the grab times out.
    const abandon = (): void => {
      cancelBrowserGrabMode(browserPageId, resolveGuest, params.requestId, 'runtime')
    }
    if (signal?.aborted) {
      return { opId: params.opId, kind: 'cancelled', reason: 'user' }
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
    const { browserPageId, resolveGuest } = await this.resolveGrabGuest(params)
    return {
      cancelled: cancelBrowserGrabMode(browserPageId, resolveGuest, params.requestId, 'runtime')
    }
  }

  async browserGrabPickedPresent(
    params: BrowserCommandTargetParams & { selectionId: string; interactive?: boolean }
  ): Promise<boolean | null> {
    const { resolveGuest } = await this.resolveGrabGuest(params)
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
    params: BrowserCommandTargetParams & { rect: BrowserGrabRect; selectionId?: string }
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
