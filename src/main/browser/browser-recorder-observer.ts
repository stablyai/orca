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

  start(): void {
    const webContents = this.bridge?.getPageWebContents(
      this.target.worktreeId,
      this.target.browserPageId
    )
    if (webContents) {
      this.attach(webContents)
      void this.injectCaptureScript()
    }
    // Why: network capture feeds the stop-time traffic summary; best-effort so
    // a missing agent-browser session cannot break the recorder toggle.
    const capture = this.bridge?.captureStart(this.target.worktreeId, this.target.browserPageId)
    void capture?.catch(() => {})
  }

  async stop(): Promise<void> {
    this.events.flushConsoleStreak()
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
  }

  private detach(): void {
    const webContents = this.attachedWebContents
    this.attachedWebContents = null
    if (!webContents) {
      return
    }
    webContents.removeListener('console-message', this.handleConsoleMessage)
    webContents.removeListener('did-navigate', this.handleNavigation)
    webContents.removeListener('did-navigate-in-page', this.handleNavigation)
    webContents.removeListener('did-finish-load', this.handleNavigation)
  }

  private async injectCaptureScript(): Promise<void> {
    try {
      await this.bridge?.evaluate(
        INTERACTION_CAPTURE_EXPRESSION,
        this.target.worktreeId,
        this.target.browserPageId
      )
    } catch {
      // Page mid-navigation or debugger busy — interaction capture is best-effort.
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
