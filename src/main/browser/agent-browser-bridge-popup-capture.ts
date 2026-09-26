import type { WebContents } from 'electron'
import type {
  BrowserNetworkEntry,
  BrowserNetworkLogResult,
  BrowserNetworkRequestItem
} from '../../shared/runtime-types'
import { stripUrlQueryAndFragment } from '../../shared/browser-url'
import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeRawProcess } from './agent-browser-bridge-raw-process'
import {
  finishNetworkRequest,
  recordNetworkResponseReceived,
  type NetworkLogRecordTarget
} from './cdp-network-log-recorder'

type PopupRequestMeta = {
  requestId: string
  resourceType?: string
}

type PopupNetworkCapture = NetworkLogRecordTarget & {
  webContents: WebContents | null
  lease: ElectronDebuggerLease | null
  messageListener: ((_event: unknown, method: string, params: unknown) => void) | null
  detachListener: (() => void) | null
  requestMethods: Map<string, string>
  requestMetaByEntry: Map<BrowserNetworkEntry, PopupRequestMeta>
}

// Why a bridge-owned collector instead of a popup daemon session: the opener's
// daemon only sees its own proxy target, and a second proxy+daemon per popup
// cannot attach before the popup's first navigation. A shared debugger lease on
// the popup WebContents attaches synchronously in the creation hook and records
// daemon-shaped request items merged into the opener's real `requests` result.
export abstract class AgentBrowserBridgePopupCapture extends AgentBrowserBridgeRawProcess {
  protected readonly popupNetworkCaptures = new Map<string, Map<number, PopupNetworkCapture>>()

  onPopupOpened(browserPageId: string, popup: WebContents): void {
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    let popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      popups = new Map()
      this.popupNetworkCaptures.set(sessionName, popups)
    }
    // Why: the custom createWindow path notifies from prepareContent and again
    // from policy attach — one attachment per popup WebContents, never two.
    if (popups.has(popup.id)) {
      return
    }
    const capture: PopupNetworkCapture = {
      webContents: popup,
      lease: null,
      messageListener: null,
      detachListener: null,
      networkLog: [],
      networkRequestMap: new Map(),
      requestMethods: new Map(),
      requestMetaByEntry: new Map()
    }
    popups.set(popup.id, capture)
    if (this.sessions.get(sessionName)?.activeCapture) {
      this.attachPopupCapture(capture)
    }
  }

  onPopupClosed(popupWebContentsId: number): void {
    for (const popups of this.popupNetworkCaptures.values()) {
      const capture = popups.get(popupWebContentsId)
      if (!capture) {
        continue
      }
      // Why: completed entries stay readable until capture stop/restart or opener
      // retirement — only the live subscription and the WebContents reference go.
      this.detachPopupCapture(capture)
      capture.webContents = null
      capture.requestMethods.clear()
      capture.networkRequestMap.clear()
      return
    }
  }

  protected attachPopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const [webContentsId, capture] of popups) {
      // Why: a fresh capture starts empty, and a popup that died while idle must
      // not hold its WebContents past capture start.
      this.clearPopupCaptureEntries(capture)
      if (!capture.webContents || capture.webContents.isDestroyed()) {
        this.detachPopupCapture(capture)
        popups.delete(webContentsId)
        continue
      }
      this.attachPopupCapture(capture)
    }
    if (popups.size === 0) {
      this.popupNetworkCaptures.delete(sessionName)
    }
  }

  protected detachPopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const capture of popups.values()) {
      this.detachPopupCapture(capture)
    }
  }

  protected stopPopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const [webContentsId, capture] of popups) {
      this.detachPopupCapture(capture)
      this.clearPopupCaptureEntries(capture)
      if (!capture.webContents) {
        popups.delete(webContentsId)
      }
    }
    if (popups.size === 0) {
      this.popupNetworkCaptures.delete(sessionName)
    }
  }

  protected releasePopupCapturesForSession(sessionName: string): void {
    const popups = this.popupNetworkCaptures.get(sessionName)
    if (!popups) {
      return
    }
    for (const capture of popups.values()) {
      this.detachPopupCapture(capture)
    }
    this.popupNetworkCaptures.delete(sessionName)
  }

  protected mergePopupNetworkEntries(
    sessionName: string,
    result: BrowserNetworkLogResult
  ): BrowserNetworkLogResult {
    const popups = this.popupNetworkCaptures.get(sessionName)
    // Why: popup entries belong to an active capture only — after a session
    // restart or without capture, the daemon result passes through untouched.
    if (!popups || !this.sessions.get(sessionName)?.activeCapture) {
      return result
    }
    const popupItems: BrowserNetworkRequestItem[] = []
    for (const capture of popups.values()) {
      for (const entry of capture.networkLog) {
        const meta = capture.requestMetaByEntry.get(entry)
        popupItems.push({
          ...(meta?.requestId !== undefined ? { requestId: meta.requestId } : {}),
          url: entry.url,
          method: entry.method,
          timestamp: entry.timestamp,
          ...(meta?.resourceType !== undefined ? { resourceType: meta.resourceType } : {}),
          status: entry.status,
          mimeType: entry.mimeType
        })
      }
    }
    // Why: byte-identical passthrough when no popup has entries — the merge must
    // not reshape a daemon result nobody asked to extend.
    if (popupItems.length === 0) {
      return result
    }
    return {
      ...result,
      requests: [...(Array.isArray(result.requests) ? result.requests : []), ...popupItems]
    }
  }

  private clearPopupCaptureEntries(capture: PopupNetworkCapture): void {
    capture.networkLog.length = 0
    capture.networkRequestMap.clear()
    capture.requestMethods.clear()
    capture.requestMetaByEntry.clear()
  }

  private handlePopupDebuggerMessage(
    capture: PopupNetworkCapture,
    method: string,
    params: unknown
  ): void {
    if (method === 'Network.requestWillBeSent') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron delivers CDP event params untyped; every field below is read defensively with optional chaining.
      const p = params as { requestId?: string; request?: { method?: string } } | undefined
      if (p?.requestId) {
        capture.requestMethods.set(p.requestId, p.request?.method ?? 'GET')
      }
      return
    }
    if (method === 'Network.responseReceived') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron delivers CDP event params untyped; every field below is read defensively with optional chaining.
      const p = params as
        | {
            requestId?: string
            response?: { url?: string }
            type?: string
          }
        | undefined
      const requestId = p?.requestId
      // Why: David's decision — hide popup query and fragment values before
      // retention; the opener's own entries are untouched by this patch.
      const oldestBefore = capture.networkLog[0]
      const evicted = recordNetworkResponseReceived(capture, params, {
        url: stripUrlQueryAndFragment(p?.response?.url ?? ''),
        method: (requestId && capture.requestMethods.get(requestId)) || '',
        timestamp: Date.now()
      })
      // Why: the recorder evicts exactly the oldest entry, so drop its request
      // metadata with it instead of scanning the map.
      if (evicted && oldestBefore) {
        capture.requestMetaByEntry.delete(oldestBefore)
      }
      if (requestId) {
        const entry = capture.networkRequestMap.get(requestId)
        if (entry) {
          capture.requestMetaByEntry.set(entry, {
            requestId,
            ...(p?.type !== undefined ? { resourceType: p.type } : {})
          })
        }
      }
      return
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      finishNetworkRequest(capture, method, params)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron delivers CDP event params untyped; the field below is read defensively with optional chaining.
      const requestId = (params as { requestId?: string } | undefined)?.requestId
      if (requestId) {
        capture.requestMethods.delete(requestId)
      }
    }
  }

  private attachPopupCapture(capture: PopupNetworkCapture): void {
    const webContents = capture.webContents
    if (capture.lease || !webContents || webContents.isDestroyed()) {
      return
    }
    try {
      capture.lease = acquireElectronDebugger(webContents)
    } catch {
      capture.lease = null
      return
    }
    const listener = (_event: unknown, method: string, params: unknown): void => {
      this.handlePopupDebuggerMessage(capture, method, params)
    }
    capture.messageListener = listener
    try {
      webContents.debugger.on('message', listener)
    } catch {
      this.detachPopupCapture(capture)
      return
    }
    const onDetach = (): void => {
      // Why: keep entries and registration — DevTools taking the debugger is a
      // pause, not a close; the next start reattaches and keeps collecting.
      this.detachPopupCapture(capture)
    }
    capture.detachListener = onDetach
    try {
      webContents.debugger.on('detach', onDetach)
    } catch {
      this.detachPopupCapture(capture)
      return
    }
    // Why: enable after subscribing so no response event can slip between the two.
    // Why the lease check: a stop or close between attach and this rejection must
    // not detach a newer attachment — only clean up if this attach is still live.
    const attachedLease = capture.lease
    void webContents.debugger.sendCommand('Network.enable', {}).catch(() => {
      if (attachedLease && capture.lease === attachedLease) {
        this.detachPopupCapture(capture)
      }
    })
  }

  private detachPopupCapture(capture: PopupNetworkCapture): void {
    const webContents = capture.webContents
    try {
      if (capture.messageListener && webContents && !webContents.isDestroyed()) {
        webContents.debugger.removeListener('message', capture.messageListener)
      }
    } catch {
      // Best-effort release: the popup may already be gone.
    }
    try {
      if (capture.detachListener && webContents && !webContents.isDestroyed()) {
        webContents.debugger.removeListener('detach', capture.detachListener)
      }
    } catch {
      // Best-effort release: the popup may already be gone.
    }
    capture.messageListener = null
    capture.detachListener = null
    const lease = capture.lease
    capture.lease = null
    try {
      lease?.release()
    } catch {
      // Best-effort release: DevTools may have taken debugger ownership.
    }
  }
}
