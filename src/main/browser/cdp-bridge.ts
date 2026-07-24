/* eslint-disable max-lines -- Why: the CDP bridge owns debugger lifecycle, ref map management, command serialization, and all browser interaction logic in one module so the browser automation boundary stays coherent. */
import { webContents } from 'electron'
import type {
  BrowserCaptureStartResult,
  BrowserCaptureStopResult,
  BrowserCheckResult,
  BrowserClearResult,
  BrowserClickResult,
  BrowserConsoleEntry,
  BrowserConsoleResult,
  BrowserCookie,
  BrowserCookieDeleteResult,
  BrowserCookieGetResult,
  BrowserCookieSetResult,
  BrowserDragResult,
  BrowserEvalResult,
  BrowserFillResult,
  BrowserFocusResult,
  BrowserGeolocationResult,
  BrowserGotoResult,
  BrowserHoverResult,
  BrowserInterceptDisableResult,
  BrowserInterceptEnableResult,
  BrowserInterceptedRequest,
  BrowserKeypressResult,
  BrowserNetworkEntry,
  BrowserNetworkLogResult,
  BrowserPdfResult,
  BrowserScreenshotResult,
  BrowserScrollResult,
  BrowserSelectAllResult,
  BrowserSelectResult,
  BrowserSnapshotResult,
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult,
  BrowserTypeResult,
  BrowserUploadResult,
  BrowserViewportResult,
  BrowserWaitResult
} from '../../shared/runtime-types'
import {
  buildSnapshot,
  type CdpCommandSender,
  type RefEntry,
  type SnapshotResult
} from './snapshot-engine'
import { insertTextThroughCdp } from './browser-text-insertion'
import type { BrowserManager } from './browser-manager'
import { ANTI_DETECTION_SCRIPT } from './anti-detection'

const CAPTURE_LOG_LIMIT = 1000

export class BrowserError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
  }
}

type TabState = {
  navigationId: string | null
  snapshotResult: SnapshotResult | null
  debuggerAttached: boolean
  debuggerDetachListener: (() => void) | null
  debuggerMessageListener: ((_event: unknown, method: string, params: unknown) => void) | null
  iframeSessions: Map<string, string>
  // Why: capture state is per-tab so one tab's console/network events don't pollute another's buffer.
  capturing: boolean
  consoleLog: BrowserConsoleEntry[]
  networkLog: BrowserNetworkEntry[]
  // Why: interception state lets the agent selectively continue or block individual requests.
  intercepting: boolean
  interceptPatterns: string[]
  pausedRequests: Map<string, BrowserInterceptedRequest>
  // Why: maps CDP requestId → networkLog entry so loadingFinished attributes size to the right overlapping response.
  networkRequestMap: Map<string, BrowserNetworkEntry>
}

type QueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export class CdpBridge {
  private activeWebContentsId: number | null = null
  private readonly tabState = new Map<string, TabState>()
  private readonly commandQueues = new Map<string, QueuedCommand[]>()
  private readonly processingQueues = new Set<string>()
  private readonly browserManager: BrowserManager

  constructor(browserManager: BrowserManager) {
    this.browserManager = browserManager
  }

  setActiveTab(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  getActivePageId(_worktreeId?: string): string | null {
    if (!this.activeWebContentsId) {
      return null
    }
    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      if (wcId === this.activeWebContentsId) {
        return tabId
      }
    }
    return null
  }

  getPageInfo(
    _worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    // Why: expose the same metadata lookup as other bridges, though the CDP bridge routes only one active tab.
    const resolvedPageId = browserPageId ?? this.getActivePageId()
    if (!resolvedPageId) {
      return null
    }
    const webContentsId = this.getRegisteredTabs().get(resolvedPageId)
    if (webContentsId == null) {
      return null
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return null
    }
    return {
      browserPageId: resolvedPageId,
      url: guest.getURL(),
      title: guest.getTitle()
    }
  }

  async snapshot(): Promise<BrowserSnapshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      const result = await buildSnapshot(sender, state.iframeSessions, (sessionId) =>
        this.makeCdpSender(guest, sessionId)
      )
      state.snapshotResult = result

      const navId = await this.getNavigationId(sender)
      state.navigationId = navId

      return {
        browserPageId: tabId,
        snapshot: result.snapshot,
        refs: result.refs,
        url: guest.getURL(),
        title: guest.getTitle()
      }
    })
  }

  async click(element: string): Promise<BrowserClickResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      await this.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
      const { cx, cy } = await this.getPageCoordinates(guest, node, localCenter.cx, localCenter.cy)

      // Why: mouseMoved fires mouseenter/mouseover so sites reveal hover-dependent menus/targets before the click lands.
      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
      await sender('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })
      await sender('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: cx,
        y: cy,
        button: 'left',
        clickCount: 1
      })

      return { clicked: element }
    })
  }

  async hover(element: string): Promise<BrowserHoverResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await this.scrollIntoView(refSender, node.backendDOMNodeId)
      const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
      const { cx, cy } = await this.getPageCoordinates(guest, node, localCenter.cx, localCenter.cy)

      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })

      return { hovered: element }
    })
  }

  async drag(fromElement: string, toElement: string): Promise<BrowserDragResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const fromNode = await this.resolveRef(guest, sender, fromElement)
      const toNode = await this.resolveRef(guest, sender, toElement)
      const fromSender = this.senderForRef(guest, fromNode)
      const toSender = this.senderForRef(guest, toNode)

      await this.scrollIntoView(fromSender, fromNode.backendDOMNodeId)
      const fromLocal = await this.getElementCenter(fromSender, fromNode.backendDOMNodeId)
      const from = await this.getPageCoordinates(guest, fromNode, fromLocal.cx, fromLocal.cy)
      const toLocal = await this.getElementCenter(toSender, toNode.backendDOMNodeId)
      const to = await this.getPageCoordinates(guest, toNode, toLocal.cx, toLocal.cy)

      // Why: interpolate the drag so intermediate elements fire dragenter/dragover, which many drag-and-drop libs require.
      await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.cx, y: from.cy })
      await sender('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: from.cx,
        y: from.cy,
        button: 'left'
      })

      const steps = 10
      for (let i = 1; i <= steps; i++) {
        const x = from.cx + ((to.cx - from.cx) * i) / steps
        const y = from.cy + ((to.cy - from.cy) * i) / steps
        await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 1 })
        await new Promise((r) => setTimeout(r, 10))
      }

      await sender('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: to.cx,
        y: to.cy,
        button: 'left'
      })

      return { dragged: { from: fromElement, to: toElement } }
    })
  }

  async uploadFile(element: string, filePaths: string[]): Promise<BrowserUploadResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await refSender('DOM.setFileInputFiles', {
        files: filePaths,
        backendNodeId: node.backendDOMNodeId
      })

      return { uploaded: filePaths.length }
    })
  }

  async goto(url: string): Promise<BrowserGotoResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { errorText } = (await sender('Page.navigate', { url })) as {
        errorText?: string
      }

      if (errorText) {
        throw new BrowserError('browser_navigation_failed', `Navigation failed: ${errorText}`)
      }

      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async fill(element: string, value: string): Promise<BrowserFillResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      // Why: select-all + delete clears the existing value before typing, matching Playwright/agent-browser fill().
      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' })
      await sender('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete' })

      await insertTextThroughCdp(sender, value)

      // Why: React's synthetic listeners ignore native key events, so dispatch input/change so controlled components update.
      // Why: use refSender for iframe sessions so document.activeElement is the focused element inside the iframe, not the parent <iframe>.
      const eventSender = node.sessionId ? refSender : sender
      await eventSender('Runtime.evaluate', {
        expression: `(() => {
          const el = document.activeElement;
          if (el) {
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }
        })()`,
        returnByValue: true
      })

      return { filled: element }
    })
  }

  async type(input: string): Promise<BrowserTypeResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await insertTextThroughCdp(sender, input)
      return { typed: true }
    })
  }

  async select(element: string, value: string): Promise<BrowserSelectResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }

      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      // Why: match on label (textContent) and value so opaque option IDs still select; also handles combobox via click.
      await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function(val) {
          if (this.options) {
            for (const opt of this.options) {
              if (opt.value === val || opt.textContent.trim() === val) {
                this.value = opt.value;
                this.dispatchEvent(new Event('input', { bubbles: true }));
                this.dispatchEvent(new Event('change', { bubbles: true }));
                return;
              }
            }
            this.value = val;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const opts = this.querySelectorAll('[role="option"], li, [data-value]');
            for (const opt of opts) {
              const text = opt.textContent ? opt.textContent.trim() : '';
              const dv = opt.getAttribute('data-value');
              if (text === val || dv === val) {
                opt.click();
                return;
              }
            }
          }
        }`,
        arguments: [{ value }]
      })

      return { selected: element }
    })
  }

  async scroll(direction: 'up' | 'down', amount?: number): Promise<BrowserScrollResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      // Why: JS scrollBy needs no focus and is deterministic, unlike mouseWheel which is unreliable in Electron webviews.
      const expr = amount
        ? `window.scrollBy(0, ${direction === 'down' ? amount : -amount})`
        : `window.scrollBy(0, ${direction === 'down' ? 'window.innerHeight' : '-window.innerHeight'})`
      await sender('Runtime.evaluate', { expression: expr, returnByValue: true })

      return { scrolled: direction }
    })
  }

  async wait(timeoutMs = 5000): Promise<BrowserWaitResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      await this.ensureDebuggerAttached(guest)
      await this.waitForNetworkIdle(guest, timeoutMs, 500)
      return { waited: true }
    })
  }

  async check(element: string, checked: boolean): Promise<BrowserCheckResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }
      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      const { result: currentState } = (await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function() { return this.checked; }',
        returnByValue: true
      })) as { result: { value: boolean } }

      if (currentState.value !== checked) {
        await this.scrollIntoView(refSender, node.backendDOMNodeId)
        const localCenter = await this.getElementCenter(refSender, node.backendDOMNodeId)
        const { cx, cy } = await this.getPageCoordinates(
          guest,
          node,
          localCenter.cx,
          localCenter.cy
        )
        await sender('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy })
        await sender('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: cx,
          y: cy,
          button: 'left',
          clickCount: 1
        })
        await sender('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: cx,
          y: cy,
          button: 'left',
          clickCount: 1
        })

        // Why: custom checkboxes may not toggle from a coordinate click; verify state and fall back to programmatic .click().
        try {
          const { result: afterState } = (await refSender('Runtime.callFunctionOn', {
            objectId: object.objectId,
            functionDeclaration: 'function() { return this.checked; }',
            returnByValue: true
          })) as { result: { value: boolean } }

          if (afterState.value !== checked) {
            await refSender('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: 'function() { this.click(); }'
            })
          }
        } catch {
          // objectId stale after re-render — click was dispatched, accept the result
        }
      }

      return { checked }
    })
  }

  async focus(element: string): Promise<BrowserFocusResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      return { focused: element }
    })
  }

  async clear(element: string): Promise<BrowserClearResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)

      const { nodeId } = (await refSender('DOM.requestNode', {
        backendNodeId: node.backendDOMNodeId
      })) as { nodeId: number }
      const { object } = (await refSender('DOM.resolveNode', { nodeId })) as {
        object: { objectId: string }
      }

      await refSender('Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: `function() {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
        }`
      })

      return { cleared: element }
    })
  }

  async selectAll(element: string): Promise<BrowserSelectAllResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const node = await this.resolveRef(guest, sender, element)
      const refSender = this.senderForRef(guest, node)
      await refSender('DOM.focus', { backendNodeId: node.backendDOMNodeId })

      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        modifiers: process.platform === 'darwin' ? 4 : 2
      })

      return { selected: element }
    })
  }

  async keypress(key: string): Promise<BrowserKeypressResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const keyDef = resolveKeyDefinition(key)
      await sender('Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...keyDef
      })
      await sender('Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...keyDef
      })

      return { pressed: key }
    })
  }

  async pdf(): Promise<BrowserPdfResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { data } = (await sender('Page.printToPDF', {
        printBackground: true
      })) as { data: string }

      return { data }
    })
  }

  async fullPageScreenshot(format: 'png' | 'jpeg' = 'png'): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const metrics = (await sender('Page.getLayoutMetrics')) as {
        cssContentSize?: { width: number; height: number }
        contentSize?: { width: number; height: number }
      }
      // Why: screenshot clip uses CSS pixels; on HiDPI, device-pixel contentSize tiles duplicates, so prefer cssContentSize.
      const contentSize = metrics.cssContentSize ?? metrics.contentSize
      if (!contentSize) {
        throw new BrowserError('browser_error', 'Unable to determine full-page screenshot bounds')
      }

      const { data } = (await sender('Page.captureScreenshot', {
        format,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.ceil(contentSize.width),
          height: Math.ceil(contentSize.height),
          scale: 1
        }
      })) as { data: string }

      return { data, format }
    })
  }

  // ── Cookie management ──

  async cookieGet(url?: string): Promise<BrowserCookieGetResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const params: Record<string, unknown> = {}
      if (url) {
        params.urls = [url]
      }
      const { cookies } = (await sender('Network.getCookies', params)) as {
        cookies: BrowserCookie[]
      }

      return { cookies }
    })
  }

  async cookieSet(cookie: {
    name: string
    value: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    sameSite?: string
    expires?: number
  }): Promise<BrowserCookieSetResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      // Why: Network.setCookie needs a domain or url to scope the cookie; infer the domain from the current page when omitted.
      let domain = cookie.domain
      if (!domain) {
        const { result: urlResult } = (await sender('Runtime.evaluate', {
          expression: 'location.hostname',
          returnByValue: true
        })) as { result: { value: string } }
        domain = urlResult.value
      }

      const params: Record<string, unknown> = {
        name: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path ?? '/',
        secure: cookie.secure ?? false,
        httpOnly: cookie.httpOnly ?? false,
        sameSite: cookie.sameSite ?? 'Lax'
      }
      if (cookie.expires !== undefined) {
        params.expires = cookie.expires
      }

      const { success } = (await sender('Network.setCookie', params)) as { success: boolean }
      return { success }
    })
  }

  async cookieDelete(
    name: string,
    domain?: string,
    url?: string
  ): Promise<BrowserCookieDeleteResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const params: Record<string, unknown> = { name }
      if (domain) {
        params.domain = domain
      }
      if (url) {
        params.url = url
      }
      // Why: Network.deleteCookies needs a domain or url; infer from the current page if neither was given.
      if (!domain && !url) {
        const { result: urlResult } = (await sender('Runtime.evaluate', {
          expression: 'location.href',
          returnByValue: true
        })) as { result: { value: string } }
        params.url = urlResult.value
      }

      await sender('Network.deleteCookies', params)
      return { deleted: true }
    })
  }

  // ── Viewport emulation ──

  async setViewport(
    width: number,
    height: number,
    deviceScaleFactor = 1,
    mobile = false
  ): Promise<BrowserViewportResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Emulation.setDeviceMetricsOverride', {
        width,
        height,
        deviceScaleFactor,
        mobile
      })
      // Why: metrics-only resize can leave the compositor surface at the old size, cropping remote screencast clients.
      await Promise.resolve(sender('Emulation.setVisibleSize', { width, height })).catch(() => {})

      return { width, height, deviceScaleFactor, mobile }
    })
  }

  // ── Geolocation ──

  async setGeolocation(
    latitude: number,
    longitude: number,
    accuracy = 1
  ): Promise<BrowserGeolocationResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Emulation.setGeolocationOverride', { latitude, longitude, accuracy })
      return { latitude, longitude, accuracy }
    })
  }

  // ── Request interception ──

  async interceptEnable(patterns: string[] = ['*']): Promise<BrowserInterceptEnableResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      const requestPatterns = patterns.map((p) => ({ urlPattern: p }))
      await sender('Fetch.enable', { patterns: requestPatterns })

      state.intercepting = true
      state.interceptPatterns = patterns

      return { enabled: true, patterns }
    })
  }

  async interceptDisable(): Promise<BrowserInterceptDisableResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      await sender('Fetch.disable')
      state.intercepting = false
      state.interceptPatterns = []
      state.pausedRequests.clear()

      return { disabled: true }
    })
  }

  interceptList(): { requests: BrowserInterceptedRequest[] } {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)
    return { requests: [...state.pausedRequests.values()] }
  }

  // TODO: Add interceptContinue/interceptBlock once agent-browser supports per-request decisions (CLI is URL-pattern-only).

  // ── Console/network capture ──

  async captureStart(): Promise<BrowserCaptureStartResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      await sender('Runtime.enable')
      state.capturing = true
      state.consoleLog = []
      state.networkLog = []
      state.networkRequestMap.clear()

      return { capturing: true }
    })
  }

  async captureStop(): Promise<BrowserCaptureStopResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const tabId = this.resolveTabId(guest.id)
      const state = this.getOrCreateTabState(tabId)

      state.capturing = false
      state.networkRequestMap.clear()

      return { stopped: true }
    })
  }

  consoleLog(limit = 100): BrowserConsoleResult {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)

    const entries = state.consoleLog.slice(-limit)
    return { entries, truncated: state.consoleLog.length > limit }
  }

  networkLog(limit = 100): BrowserNetworkLogResult {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)

    const entries = state.networkLog.slice(-limit)
    return { entries, truncated: state.networkLog.length > limit }
  }

  async back(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.navigateToHistoryEntry', {
        entryId: await this.getPreviousHistoryEntryId(sender)
      })
      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async reload(): Promise<{ url: string; title: string }> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      await sender('Page.reload')
      await this.waitForLoad(sender, guest)
      this.invalidateRefMap(guest.id)

      return { url: guest.getURL(), title: guest.getTitle() }
    })
  }

  async screenshot(format: 'png' | 'jpeg' = 'png'): Promise<BrowserScreenshotResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { data } = (await sender('Page.captureScreenshot', {
        format
      })) as { data: string }

      return { data, format }
    })
  }

  async evaluate(expression: string): Promise<BrowserEvalResult> {
    return this.enqueueCommand(async () => {
      const guest = this.getActiveGuest()
      const sender = this.makeCdpSender(guest)
      await this.ensureDebuggerAttached(guest)

      const { result, exceptionDetails } = (await sender('Runtime.evaluate', {
        expression,
        returnByValue: true
      })) as {
        result: { value?: unknown; type: string; description?: string }
        exceptionDetails?: { text: string; exception?: { description?: string } }
      }

      if (exceptionDetails) {
        throw new BrowserError(
          'browser_eval_error',
          exceptionDetails.exception?.description ?? exceptionDetails.text
        )
      }

      const valueStr =
        result.value !== undefined ? String(result.value) : (result.description ?? '')
      // Why: include origin to match agent-browser's BrowserEvalResult shape across both bridges.
      const { result: urlResult } = (await sender('Runtime.evaluate', {
        expression: 'location.origin',
        returnByValue: true
      })) as { result: { value: string } }
      return {
        result: valueStr,
        origin: urlResult.value
      }
    })
  }

  tabList(): BrowserTabListResult {
    const tabs: BrowserTabInfo[] = []
    let index = 0

    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      const guest = webContents.fromId(wcId)
      if (!guest || guest.isDestroyed()) {
        continue
      }
      tabs.push({
        browserPageId: tabId,
        index,
        url: guest.getURL(),
        title: guest.getTitle(),
        active: wcId === this.activeWebContentsId
      })
      index++
    }

    return { tabs }
  }

  async tabSwitch(index: number): Promise<BrowserTabSwitchResult> {
    // Why: filter to live tabs so indices match tabList(), skipping destroyed-but-uncleaned entries.
    const liveEntries = [...this.getRegisteredTabs()].filter(([_, wcId]) => {
      const guest = webContents.fromId(wcId)
      return guest && !guest.isDestroyed()
    })
    if (index < 0 || index >= liveEntries.length) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Tab index ${index} is out of range. ${liveEntries.length} tab(s) open.`
      )
    }

    const [tabId, wcId] = liveEntries[index]
    if (this.activeWebContentsId !== null) {
      this.invalidateRefMap(this.activeWebContentsId)
    }
    this.activeWebContentsId = wcId

    return { switched: index, browserPageId: tabId }
  }

  onTabClosed(webContentsId: number): void {
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = null
    }
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.tabState.get(tabId)
      const guest = webContents.fromId(webContentsId)
      if (state && guest) {
        this.removeDebuggerListeners(guest, state)
      }
      this.tabState.delete(tabId)
      this.commandQueues.delete(tabId)
    }
  }

  onTabChanged(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }

  // ── Private helpers ──

  private getActiveGuest(): Electron.WebContents {
    if (this.activeWebContentsId !== null) {
      const guest = webContents.fromId(this.activeWebContentsId)
      if (guest && !guest.isDestroyed()) {
        return guest
      }
      // Why: webContentsId goes stale after a process swap; fall through to auto-select since the tab may have a new id.
      this.activeWebContentsId = null
    }

    const tabs = [...this.getRegisteredTabs()]
    if (tabs.length === 0) {
      throw new BrowserError(
        'browser_no_tab',
        'No browser tab is open. Use the Orca UI to open a browser tab first.'
      )
    }
    if (tabs.length === 1) {
      this.activeWebContentsId = tabs[0][1]
    } else {
      throw new BrowserError(
        'browser_no_tab',
        "Multiple browser tabs are open. Run 'orca tab list' and 'orca tab switch --index <n>' to select one."
      )
    }

    const guest = webContents.fromId(this.activeWebContentsId!)
    if (!guest || guest.isDestroyed()) {
      this.activeWebContentsId = null
      throw new BrowserError(
        'browser_debugger_detached',
        "The active browser tab was closed. Run 'orca tab list' to find remaining tabs."
      )
    }
    return guest
  }

  private getRegisteredTabs(): Map<string, number> {
    // Why: reach into BrowserManager's private tab map since it exposes no public listTabs().
    return (this.browserManager as unknown as { webContentsIdByTabId: Map<string, number> })
      .webContentsIdByTabId
  }

  private resolveTabId(webContentsId: number): string {
    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    throw new BrowserError('browser_debugger_detached', 'Tab is no longer registered.')
  }

  private resolveTabIdSafe(webContentsId: number): string | null {
    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      if (wcId === webContentsId) {
        return tabId
      }
    }
    return null
  }

  private getOrCreateTabState(tabId: string): TabState {
    let state = this.tabState.get(tabId)
    if (!state) {
      state = {
        navigationId: null,
        snapshotResult: null,
        debuggerAttached: false,
        debuggerDetachListener: null,
        debuggerMessageListener: null,
        iframeSessions: new Map(),
        capturing: false,
        consoleLog: [],
        networkLog: [],
        intercepting: false,
        interceptPatterns: [],
        pausedRequests: new Map(),
        networkRequestMap: new Map()
      }
      this.tabState.set(tabId, state)
    }
    return state
  }

  private removeDebuggerListeners(guest: Electron.WebContents, state: TabState): void {
    const detachListener = state.debuggerDetachListener
    const messageListener = state.debuggerMessageListener
    state.debuggerDetachListener = null
    state.debuggerMessageListener = null

    if (detachListener) {
      try {
        guest.debugger.removeListener('detach', detachListener as never)
      } catch {
        // guest may already be destroyed
      }
    }
    if (messageListener) {
      try {
        guest.debugger.removeListener('message', messageListener as never)
      } catch {
        // guest may already be destroyed
      }
    }
  }

  private async ensureDebuggerAttached(guest: Electron.WebContents): Promise<void> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)
    if (state.debuggerAttached && guest.debugger.isAttached()) {
      return
    }

    try {
      // Why: BrowserManager already attached the debugger; reuse it to avoid "another debugger is already attached."
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch {
      throw new BrowserError(
        'browser_cdp_error',
        'Could not attach debugger. DevTools may already be open for this tab.'
      )
    }

    const sender = this.makeCdpSender(guest)
    await sender('Page.enable')
    await sender('DOM.enable')
    await sender('Network.enable')

    // Why: OOPIF iframes are invisible to the parent CDP session; flatten:true gives each a targetable sessionId.
    await sender('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    })

    // Why: CDP attach exposes automation signals (navigator.webdriver) that Cloudflare checks; override per new document.
    await sender('Page.addScriptToEvaluateOnNewDocument', {
      source: ANTI_DETECTION_SCRIPT
    })

    // Why: only remove this bridge's listeners; screencast/proxy sessions share the debugger and own their teardown.
    this.removeDebuggerListeners(guest, state)

    const detachListener = (): void => {
      state.debuggerAttached = false
      state.snapshotResult = null
      state.iframeSessions.clear()
      this.removeDebuggerListeners(guest, state)
    }

    const messageListener = (_event: unknown, method: string, params: unknown): void => {
      if (method === 'Page.frameNavigated') {
        state.snapshotResult = null
        state.navigationId = null
      }
      // Why: an unhandled JS dialog blocks all subsequent CDP commands; auto-dismiss to avoid hanging.
      if (method === 'Page.javascriptDialogOpening') {
        const dialog = params as { type: string; message: string } | undefined
        guest.debugger
          .sendCommand('Page.handleJavaScriptDialog', {
            accept: dialog?.type !== 'beforeunload'
          })
          .catch(() => {})
      }
      // Why: track iframe sessions so CDP commands and AX queries route to the correct session.
      if (method === 'Target.attachedToTarget') {
        const p = params as
          | {
              sessionId?: string
              targetInfo?: { type?: string; targetId?: string }
            }
          | undefined
        if (p?.sessionId && p.targetInfo?.type === 'iframe' && p.targetInfo.targetId) {
          state.iframeSessions.set(p.targetInfo.targetId, p.sessionId)
          guest.debugger.sendCommand('DOM.enable', {}, p.sessionId).catch(() => {})
          guest.debugger.sendCommand('Accessibility.enable', {}, p.sessionId).catch(() => {})
          guest.debugger.sendCommand('Runtime.enable', {}, p.sessionId).catch(() => {})
        }
      }
      if (method === 'Target.detachedFromTarget') {
        const p = params as { sessionId?: string } | undefined
        if (p?.sessionId) {
          for (const [frameId, sid] of state.iframeSessions) {
            if (sid === p.sessionId) {
              state.iframeSessions.delete(frameId)
              break
            }
          }
        }
      }
      // Why: buffer console/network events per-tab so the agent can retrieve them on demand.
      if (state.capturing) {
        if (method === 'Runtime.consoleAPICalled') {
          const p = params as
            | {
                type?: string
                args?: { value?: string; description?: string }[]
                timestamp?: number
                stackTrace?: { callFrames?: { url?: string; lineNumber?: number }[] }
              }
            | undefined
          if (p) {
            const text = (p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
            state.consoleLog.push({
              level: p.type ?? 'log',
              text,
              timestamp: p.timestamp ?? Date.now(),
              url: p.stackTrace?.callFrames?.[0]?.url,
              line: p.stackTrace?.callFrames?.[0]?.lineNumber
            })
            if (state.consoleLog.length > CAPTURE_LOG_LIMIT) {
              state.consoleLog.shift()
            }
          }
        }
        if (method === 'Network.responseReceived') {
          const p = params as
            | {
                requestId?: string
                response?: {
                  url?: string
                  status?: number
                  mimeType?: string
                  headers?: Record<string, string>
                }
                type?: string
                timestamp?: number
              }
            | undefined
          if (p?.response) {
            const entry: BrowserNetworkEntry = {
              url: p.response.url ?? '',
              method: '',
              status: p.response.status ?? 0,
              mimeType: p.response.mimeType ?? '',
              size: 0,
              timestamp: p.timestamp ?? Date.now()
            }
            state.networkLog.push(entry)
            // Why: map requestId→entry so loadingFinished attributes size to the right response, not the latest one.
            if (p.requestId) {
              state.networkRequestMap.set(p.requestId, entry)
            }
            if (state.networkLog.length > CAPTURE_LOG_LIMIT) {
              const evicted = state.networkLog.shift()
              if (evicted) {
                for (const [requestId, requestEntry] of state.networkRequestMap) {
                  if (requestEntry === evicted) {
                    state.networkRequestMap.delete(requestId)
                    break
                  }
                }
              }
            }
          }
        }
        if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          const p = params as { requestId?: string; encodedDataLength?: number } | undefined
          if (p?.requestId) {
            const entry = state.networkRequestMap.get(p.requestId)
            if (entry && method === 'Network.loadingFinished' && p.encodedDataLength) {
              entry.size = p.encodedDataLength
            }
            state.networkRequestMap.delete(p.requestId)
          }
        }
      }
      // Why: buffer paused requests so the agent can later inspect and continue or block them.
      if (state.intercepting && method === 'Fetch.requestPaused') {
        const p = params as
          | {
              requestId?: string
              request?: { url?: string; method?: string; headers?: Record<string, string> }
              resourceType?: string
            }
          | undefined
        if (p?.requestId && p.request) {
          state.pausedRequests.set(p.requestId, {
            id: p.requestId,
            url: p.request.url ?? '',
            method: p.request.method ?? 'GET',
            headers: (p.request.headers ?? {}) as Record<string, string>,
            resourceType: p.resourceType ?? 'Other'
          })
        }
      }
    }

    state.debuggerDetachListener = detachListener
    state.debuggerMessageListener = messageListener
    guest.debugger.on('detach', detachListener)
    guest.debugger.on('message', messageListener)

    state.debuggerAttached = true
  }

  private makeCdpSender(guest: Electron.WebContents, sessionId?: string): CdpCommandSender {
    return (method: string, params?: Record<string, unknown>) => {
      const command = guest.debugger.sendCommand(method, params, sessionId) as Promise<unknown>
      // Why: Electron's CDP sendCommand can hang on a stale debugger session, so a 10s timeout bounds the RPC.
      let timer: ReturnType<typeof setTimeout>
      return Promise.race([
        command.finally(() => clearTimeout(timer)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new BrowserError('browser_cdp_error', `CDP command "${method}" timed out`)),
            10_000
          )
        })
      ])
    }
  }

  private senderForRef(guest: Electron.WebContents, ref: RefEntry): CdpCommandSender {
    return ref.sessionId ? this.makeCdpSender(guest, ref.sessionId) : this.makeCdpSender(guest)
  }

  private async resolveRef(
    guest: Electron.WebContents,
    sender: CdpCommandSender,
    ref: string
  ): Promise<RefEntry> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)

    if (!state.snapshotResult) {
      throw new BrowserError(
        'browser_stale_ref',
        "No snapshot exists for this tab. Run 'orca snapshot' first."
      )
    }

    const entry = state.snapshotResult.refMap.get(ref)
    if (!entry) {
      throw new BrowserError(
        'browser_ref_not_found',
        `Element ref ${ref} was not found. Run 'orca snapshot' to see available refs.`
      )
    }

    // Why: iframe refs use a child session with independent nav history, so a parent-navId check would falsely reject them.
    if (!entry.sessionId) {
      const currentNavId = await this.getNavigationId(sender)
      if (state.navigationId && currentNavId !== state.navigationId) {
        state.snapshotResult = null
        state.navigationId = null
        throw new BrowserError(
          'browser_stale_ref',
          "The page has navigated since the last snapshot. Run 'orca snapshot' to get fresh refs."
        )
      }
    }

    const refSender = entry.sessionId ? this.makeCdpSender(guest, entry.sessionId) : sender
    try {
      await refSender('DOM.describeNode', { backendNodeId: entry.backendDOMNodeId })
      return entry
    } catch {
      // Why: dynamic pages re-render nodes, detaching snapshot refs; re-query the AX tree by role+name for the fresh node.
      const recovered = await this.tryRecoverRef(refSender, entry)
      if (recovered) {
        entry.backendDOMNodeId = recovered
        return entry
      }
      state.snapshotResult = null
      throw new BrowserError(
        'browser_stale_ref',
        `Element ${ref} no longer exists in the DOM. Run 'orca snapshot' to get fresh refs.`
      )
    }
  }

  private async scrollIntoView(sender: CdpCommandSender, backendNodeId: number): Promise<void> {
    const { nodeId } = (await sender('DOM.requestNode', { backendNodeId })) as { nodeId: number }
    const { object } = (await sender('DOM.resolveNode', { nodeId })) as {
      object: { objectId: string }
    }
    await sender('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`
    })
  }

  private async getElementCenter(
    sender: CdpCommandSender,
    backendNodeId: number
  ): Promise<{ cx: number; cy: number }> {
    const { model } = (await sender('DOM.getBoxModel', { backendNodeId })) as {
      model: { content: number[] }
    }
    const [x1, y1, , , x3, y3] = model.content
    return { cx: (x1 + x3) / 2, cy: (y1 + y3) / 2 }
  }

  // Why: cross-origin iframes report iframe-local coords, but Input events use parent-page space; add the iframe offset.
  private async getIframeOffset(
    guest: Electron.WebContents,
    sessionId: string
  ): Promise<{ offsetX: number; offsetY: number }> {
    const tabId = this.resolveTabId(guest.id)
    const state = this.getOrCreateTabState(tabId)
    const parentSender = this.makeCdpSender(guest)

    for (const [targetId, sid] of state.iframeSessions) {
      if (sid === sessionId) {
        try {
          // Why: match the iframe's target URL against DOM iframe src to pick the right element on multi-iframe pages.
          const { targetInfo } = (await parentSender('Target.getTargetInfo', {
            targetId
          })) as { targetInfo: { url?: string } }

          const targetUrl = targetInfo?.url

          const { result } = (await parentSender('Runtime.evaluate', {
            expression: `(() => {
              const frames = document.querySelectorAll('iframe, frame');
              const rects = [];
              for (const f of frames) {
                const rect = f.getBoundingClientRect();
                rects.push({ x: rect.x, y: rect.y, src: f.src || '' });
              }
              return JSON.stringify(rects);
            })()`,
            returnByValue: true
          })) as { result: { value: string } }

          const rects = JSON.parse(result.value) as { x: number; y: number; src: string }[]

          // Match by URL first (reliable for cross-origin iframes)
          if (targetUrl) {
            for (const rect of rects) {
              if (rect.src === targetUrl) {
                return { offsetX: rect.x, offsetY: rect.y }
              }
            }
            // Why: iframe may redirect after load so src differs from target URL; match by origin as a fallback.
            try {
              const targetOrigin = new URL(targetUrl).origin
              for (const rect of rects) {
                if (rect.src && new URL(rect.src).origin === targetOrigin) {
                  return { offsetX: rect.x, offsetY: rect.y }
                }
              }
            } catch {
              // URL parsing failed — fall through
            }
          }

          // Fallback: if only one iframe exists, use its position
          if (rects.length === 1) {
            return { offsetX: rects[0].x, offsetY: rects[0].y }
          }
        } catch {
          // Can't determine offset, return zero (best effort)
        }
        break
      }
    }

    return { offsetX: 0, offsetY: 0 }
  }

  // Why: Input.dispatchMouseEvent uses parent-page coords, so translate iframe-local coords for iframe elements.
  private async getPageCoordinates(
    guest: Electron.WebContents,
    refEntry: RefEntry,
    localCx: number,
    localCy: number
  ): Promise<{ cx: number; cy: number }> {
    if (!refEntry.sessionId) {
      return { cx: localCx, cy: localCy }
    }
    const { offsetX, offsetY } = await this.getIframeOffset(guest, refEntry.sessionId)
    return { cx: localCx + offsetX, cy: localCy + offsetY }
  }

  // Why: nth-index disambiguates duplicate role+name matches so recovery hits the original element, not the first match.
  private async tryRecoverRef(sender: CdpCommandSender, entry: RefEntry): Promise<number | null> {
    try {
      const { nodes } = (await sender('Accessibility.getFullAXTree')) as {
        nodes: { role?: { value: string }; name?: { value: string }; backendDOMNodeId?: number }[]
      }
      const matches: number[] = []
      for (const node of nodes) {
        if (
          node.role?.value === entry.role &&
          node.name?.value === entry.name &&
          node.backendDOMNodeId
        ) {
          matches.push(node.backendDOMNodeId)
        }
      }

      const targetIndex = (entry.nth ?? 1) - 1
      const candidates = targetIndex < matches.length ? [matches[targetIndex], ...matches] : matches

      for (const backendNodeId of candidates) {
        try {
          await sender('DOM.describeNode', { backendNodeId })
          return backendNodeId
        } catch {
          continue
        }
      }
    } catch {
      // AX tree unavailable — can't recover
    }
    return null
  }

  private async getNavigationId(sender: CdpCommandSender): Promise<string> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number; url: string }[]
      currentIndex: number
    }
    const current = entries[currentIndex]
    return current ? `${current.id}:${current.url}` : 'unknown'
  }

  private async getPreviousHistoryEntryId(sender: CdpCommandSender): Promise<number> {
    const { entries, currentIndex } = (await sender('Page.getNavigationHistory')) as {
      entries: { id: number }[]
      currentIndex: number
    }
    if (currentIndex <= 0) {
      throw new BrowserError('browser_navigation_failed', 'No previous history entry.')
    }
    return entries[currentIndex - 1].id
  }

  private async waitForLoad(sender: CdpCommandSender, guest: Electron.WebContents): Promise<void> {
    // Why: SPAs fire 'load' before async content renders, so also wait for 500ms of network idle.
    const TIMEOUT_MS = 25_000
    const IDLE_MS = 500
    const startedAt = Date.now()

    // Phase 1: wait for readyState=complete
    await new Promise<void>((resolve, reject) => {
      let settled = false
      let pollTimer: ReturnType<typeof setTimeout> | null = null

      const finish = (callback: () => void): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        if (pollTimer) {
          clearTimeout(pollTimer)
          pollTimer = null
        }
        callback()
      }

      const timeout = setTimeout(() => {
        finish(() => reject(new BrowserError('browser_timeout', 'Page load timed out.')))
      }, TIMEOUT_MS)

      const check = async (): Promise<void> => {
        if (settled) {
          return
        }
        try {
          const { result } = (await sender('Runtime.evaluate', {
            expression: 'document.readyState',
            returnByValue: true
          })) as { result: { value: string } }
          if (settled) {
            return
          }
          if (result.value === 'complete') {
            finish(resolve)
          } else {
            pollTimer = setTimeout(() => {
              pollTimer = null
              void check()
            }, 100)
          }
        } catch {
          finish(resolve)
        }
      }
      void check()
    })

    // Phase 2: wait for network idle
    const remaining = TIMEOUT_MS - (Date.now() - startedAt)
    if (remaining <= 0) {
      return
    }
    await this.waitForNetworkIdle(guest, Math.min(remaining, 5000), IDLE_MS)
  }

  private waitForNetworkIdle(
    guest: Electron.WebContents,
    timeoutMs: number,
    idleMs: number
  ): Promise<void> {
    return new Promise((resolve) => {
      let pending = 0
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      const overallTimeout = setTimeout(done, timeoutMs)

      function done(): void {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(overallTimeout)
        if (idleTimer) {
          clearTimeout(idleTimer)
        }
        guest.debugger.removeListener('message', onMessage)
        resolve()
      }

      function checkIdle(): void {
        if (pending <= 0) {
          if (idleTimer) {
            clearTimeout(idleTimer)
          }
          idleTimer = setTimeout(done, idleMs)
        }
      }

      function onMessage(_event: unknown, method: string): void {
        if (method === 'Network.requestWillBeSent') {
          pending++
          if (idleTimer) {
            clearTimeout(idleTimer)
            idleTimer = null
          }
        } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
          pending = Math.max(0, pending - 1)
          checkIdle()
        }
      }

      guest.debugger.on('message', onMessage)
      checkIdle()
    })
  }

  private invalidateRefMap(webContentsId: number): void {
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.tabState.get(tabId)
      if (state) {
        state.snapshotResult = null
        state.navigationId = null
      }
    }
  }

  private async enqueueCommand<T>(execute: () => Promise<T>): Promise<T> {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(tabId)
      if (!queue) {
        queue = []
        this.commandQueues.set(tabId, queue)
      }
      queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(tabId)
    })
  }

  private async processQueue(tabId: string): Promise<void> {
    if (this.processingQueues.has(tabId)) {
      return
    }
    this.processingQueues.add(tabId)

    const queue = this.commandQueues.get(tabId)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    this.processingQueues.delete(tabId)
  }
}

// Why: Input.dispatchKeyEvent needs `text` for keys with default actions (Enter/Tab), or Chrome skips the action.
type KeyDefinition = {
  key: string
  code: string
  windowsVirtualKeyCode?: number
  text?: string
}

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' }
}

function resolveKeyDefinition(key: string): KeyDefinition {
  if (KEY_DEFINITIONS[key]) {
    return KEY_DEFINITIONS[key]
  }
  // Why: sites that check event.code drop events with invalid code values.
  if (key.length === 1) {
    const charCode = key.charCodeAt(0)
    if (charCode >= 48 && charCode <= 57) {
      return { key, code: `Digit${key}`, windowsVirtualKeyCode: charCode, text: key }
    }
    if ((charCode >= 65 && charCode <= 90) || (charCode >= 97 && charCode <= 122)) {
      return {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
        text: key
      }
    }
    return { key, code: '', windowsVirtualKeyCode: charCode, text: key }
  }
  return { key, code: key }
}
