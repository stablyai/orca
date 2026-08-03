// ---------------------------------------------------------------------------
// Browser action recorder — recording session observer
//
// While a recording session is active: listens to the page's console-message
// events (tagged lines become manual interactions and network requests,
// everything else coalesces into console entries), injects the in-page capture
// script (fetch/XHR, clicks, typing bursts, hovers, scroll), re-arms after any
// navigation, and on stop emits a network summary. All streams are best-effort
// and capped; observer failures never throw.
// ---------------------------------------------------------------------------

import type { BrowserWindow, WebContents } from 'electron'

import {
  BROWSER_RECORDER_INTERACTION_TAG,
  type BrowserRecorderStreamEvent
} from '../../shared/browser-recorder-automation'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { INTERACTION_CAPTURE_EXPRESSION } from './browser-page-capture-expressions'
import {
  parseBrowserInteractionMessage,
  parseBrowserRequestMessage
} from './browser-recorder-message-parsing'
import type { ConsoleMessageDetails } from './browser-console-streak'
import { BrowserRecorderEventRecorder } from './browser-recorder-event-recorder'
import { BrowserRecorderWebRequest } from './browser-recorder-web-request'
import {
  BrowserRecorderPageSource,
  type BrowserActionRecorderTarget
} from './browser-recorder-page-source'

export type { BrowserActionRecorderTarget } from './browser-recorder-page-source'

export type BrowserRecorderObserverHooks = {
  getBridge: () => AgentBrowserBridge | null
  getWindow: () => BrowserWindow | undefined
  /** Sends one stream event to the renderer. */
  send: (event: BrowserRecorderStreamEvent) => void
}

/** Public hook surface: the recorder injects `send` itself. */
export type BrowserRecorderObserverHookInput = Omit<BrowserRecorderObserverHooks, 'send'>

export class BrowserRecorderSessionObserver {
  private readonly bridge: AgentBrowserBridge | null
  private readonly target: BrowserActionRecorderTarget
  private readonly send: (event: BrowserRecorderStreamEvent) => void
  private readonly pageSource: BrowserRecorderPageSource
  private readonly events: BrowserRecorderEventRecorder
  private attachedWebContents: WebContents | null = null
  private readonly handleConsoleMessage: (
    details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>
  ) => void
  private readonly handleNavigation = (): void => {
    this.rearm()
  }
  private readonly handleFrameCreated = (
    _event: unknown,
    details: { frame: Electron.WebFrameMain | null }
  ): void => {
    // Why: late-created iframes (SPA dialogs, lazy content) need the capture
    // script too; cross-origin frames throw, which is expected and ignored.
    const frame = details.frame
    if (frame) {
      void frame.executeJavaScript(INTERACTION_CAPTURE_EXPRESSION).catch(() => {})
    }
  }
  private readonly handleFrameNavigate = (): void => {
    // Why: iframe navigations are recorded as requests by the webRequest
    // safety net; here they only trigger a re-inject of the capture script.
    this.rearm()
  }
  private detachWebRequest: (() => void) | null = null

  constructor(hooks: BrowserRecorderObserverHooks, target: BrowserActionRecorderTarget) {
    this.bridge = hooks.getBridge()
    this.target = target
    this.send = hooks.send
    this.pageSource = new BrowserRecorderPageSource(this.bridge, target)
    this.events = new BrowserRecorderEventRecorder(this.send, this.pageSource)
    this.handleConsoleMessage = (details) => {
      // Why: Electron ≥32 carries the console details on the event object;
      // the trailing positional args are deprecated legacy forms.
      this.onPageConsoleMessage({
        level: details.level,
        message: details.message,
        lineNumber: details.lineNumber,
        sourceId: details.sourceId
      })
    }
  }

  /**
   * Attaches the observer to the target page. Returns false (and warns) when
   * the page cannot be resolved — the recorder must fail visibly instead of
   * silently recording nothing.
   */
  start(): boolean {
    const webContents = this.bridge?.getPageWebContents(
      this.target.worktreeId,
      this.target.browserPageId
    )
    if (webContents) {
      this.attach(webContents)
      void this.injectCaptureScript()
    } else {
      console.warn(
        '[browser-recorder] recording could not attach: no webContents for target',
        JSON.stringify(this.target)
      )
      // Why: network capture feeds the stop-time traffic summary; best-effort so
      // a missing agent-browser session cannot break the recorder toggle.
      const capture = this.bridge?.captureStart(this.target.worktreeId, this.target.browserPageId)
      void capture?.catch(() => {})
      return false
    }
    const capture = this.bridge?.captureStart(this.target.worktreeId, this.target.browserPageId)
    void capture?.catch(() => {})
    return true
  }

  async stop(): Promise<void> {
    this.events.flushConsoleStreak()
    this.events.dispose()
    this.detach()
    await this.emitNetworkSummary()
    const stopCapture = this.bridge?.captureStop(this.target.worktreeId, this.target.browserPageId)
    void stopCapture?.catch(() => {})
  }

  /**
   * Re-attaches after a navigation: cross-process navigation can replace the
   * guest webContents (the old listeners die with it) and the in-page capture
   * script is gone. Idempotent; safe to call after every action.
   */
  rearm(): void {
    const current = this.bridge?.getPageWebContents(
      this.target.worktreeId,
      this.target.browserPageId
    )
    if (current && current !== this.attachedWebContents) {
      this.detach()
      this.attach(current)
    }
    void this.injectCaptureScript()
  }

  private attach(webContents: WebContents): void {
    this.attachedWebContents = webContents
    webContents.on('console-message', this.handleConsoleMessage)
    // Why: manual logins and SPA routes can reload/replace the page without any
    // automation action — the capture script must survive those too.
    webContents.on('did-navigate', this.handleNavigation)
    webContents.on('did-navigate-in-page', this.handleNavigation)
    webContents.on('did-finish-load', this.handleNavigation)
    webContents.on('frame-created', this.handleFrameCreated)
    webContents.on('did-frame-navigate', this.handleFrameNavigate)
    // Why: authoritative request capture (xhr/fetch/iframe submits) that the
    // in-page hook cannot see; scoped to this webContents.
    this.detachWebRequest = BrowserRecorderWebRequest.attach(
      webContents.session,
      webContents.id,
      (details) => this.events.recordWebRequest(details)
    )
  }

  private detach(): void {
    const webContents = this.attachedWebContents
    this.attachedWebContents = null
    this.detachWebRequest?.()
    this.detachWebRequest = null
    if (!webContents) {
      return
    }
    webContents.removeListener('console-message', this.handleConsoleMessage)
    webContents.removeListener('did-navigate', this.handleNavigation)
    webContents.removeListener('did-navigate-in-page', this.handleNavigation)
    webContents.removeListener('did-finish-load', this.handleNavigation)
    webContents.removeListener('frame-created', this.handleFrameCreated)
    webContents.removeListener('did-frame-navigate', this.handleFrameNavigate)
  }

  private async injectCaptureScript(): Promise<void> {
    const webContents = this.attachedWebContents
    if (!webContents || !webContents.mainFrame) {
      return
    }
    // Why: the page can nest content in iframes (menu/content splits); inject
    // into every frame so clicks/typing/requests inside them are captured too.
    const frames = [webContents.mainFrame, ...webContents.mainFrame.frames]
    for (const frame of frames) {
      try {
        await frame.executeJavaScript(INTERACTION_CAPTURE_EXPRESSION)
      } catch {
        // Cross-origin or mid-navigation frame — capture is best-effort.
      }
    }
  }

  private onPageConsoleMessage(details: ConsoleMessageDetails): void {
    const message = details.message ?? ''
    if (message.startsWith(BROWSER_RECORDER_INTERACTION_TAG)) {
      const interaction = parseBrowserInteractionMessage(message)
      if (interaction) {
        this.events.recordInteraction(interaction)
        return
      }
      const request = parseBrowserRequestMessage(message)
      if (request) {
        void this.events.recordRequest(request)
        return
      }
      // Tagged but unparsable — treat as console noise.
    }
    this.events.recordConsoleEntry(details)
  }

  private async emitNetworkSummary(): Promise<void> {
    const summary = await this.pageSource.networkSummary()
    if (summary) {
      this.send({ kind: 'network-summary', summary })
    }
  }
}
