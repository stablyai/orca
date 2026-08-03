// ---------------------------------------------------------------------------
// Browser action recorder — recording session observer
//
// While a recording session is active: listens to the page's console-message
// events (tagged lines become manual interactions, everything else console
// entries), injects the in-page interaction capture script, starts the
// agent-browser network capture, and on stop emits a network summary. All
// streams are best-effort and capped; observer failures never throw.
// ---------------------------------------------------------------------------

import type { BrowserWindow, WebContents } from 'electron'

import {
  BROWSER_RECORDER_BUDGET,
  BROWSER_RECORDER_INTERACTION_TAG,
  type BrowserRecorderConsoleEntry,
  type BrowserRecorderConsoleLevel,
  type BrowserRecorderInteraction,
  type BrowserRecorderNetworkSummary,
  type BrowserRecorderStreamEvent
} from '../../shared/browser-recorder-automation'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import {
  INTERACTION_CAPTURE_EXPRESSION,
  parseBrowserInteractionMessage,
  summarizeBrowserNetworkEntries
} from './browser-action-recorder-utils'

export type BrowserActionRecorderTarget = {
  worktreeId?: string
  browserPageId?: string
}

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
  private attachedWebContents: WebContents | null = null
  private readonly handleConsoleMessage: (
    details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>
  ) => void
  private interactionCount = 0
  private consoleCount = 0
  private capWarned = false
  private interactionCapWarned = false

  constructor(hooks: BrowserRecorderObserverHooks, target: BrowserActionRecorderTarget) {
    this.bridge = hooks.getBridge()
    this.target = target
    this.send = hooks.send
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
      this.attachedWebContents = webContents
      webContents.on('console-message', this.handleConsoleMessage)
      void this.injectCaptureScript()
    }
    // Why: network capture feeds the stop-time traffic summary; best-effort so
    // a missing agent-browser session cannot break the recorder toggle.
    const capture = this.bridge?.captureStart(this.target.worktreeId, this.target.browserPageId)
    void capture?.catch(() => {})
  }

  async stop(): Promise<void> {
    const webContents = this.attachedWebContents
    this.attachedWebContents = null
    if (webContents) {
      webContents.removeListener('console-message', this.handleConsoleMessage)
    }
    await this.emitNetworkSummary()
    const stopCapture = this.bridge?.captureStop(this.target.worktreeId, this.target.browserPageId)
    void stopCapture?.catch(() => {})
  }

  /**
   * Re-attaches after a navigation: cross-process navigation can replace the
   * guest webContents (the old listener dies with it) and the in-page capture
   * script is gone. Idempotent; safe to call after every action.
   */
  rearm(): void {
    const current = this.bridge?.getPageWebContents(
      this.target.worktreeId,
      this.target.browserPageId
    )
    if (current && current !== this.attachedWebContents) {
      this.attachedWebContents?.removeListener('console-message', this.handleConsoleMessage)
      this.attachedWebContents = current
      current.on('console-message', this.handleConsoleMessage)
    }
    void this.injectCaptureScript()
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
      this.recordInteraction(message)
    } else {
      this.recordConsoleEntry(details)
    }
  }

  private recordInteraction(message: string): void {
    const payload = parseBrowserInteractionMessage(message)
    if (!payload) {
      return
    }
    if (this.interactionCount >= BROWSER_RECORDER_BUDGET.interactionMaxPerSession) {
      if (!this.interactionCapWarned) {
        this.interactionCapWarned = true
        this.send({
          kind: 'console',
          entry: {
            id: `${this.pageContext().browserPageId}:interaction:cap`,
            level: 'warning',
            message: `Recorder interaction cap reached (${BROWSER_RECORDER_BUDGET.interactionMaxPerSession} events); further manual interactions are dropped.`,
            source: 'orca-recorder',
            lineNumber: 0,
            page: this.pageContext(),
            startedAt: new Date().toISOString()
          }
        })
      }
      return
    }
    this.interactionCount += 1
    const page = this.pageContext()
    const interaction: BrowserRecorderInteraction = {
      id: `${page.browserPageId}:interaction:${this.interactionCount}`,
      kind: payload.type,
      page,
      startedAt: new Date().toISOString(),
      x: payload.x,
      y: payload.y,
      target: payload.target,
      tagName: payload.tagName,
      key: payload.type === 'keydown' ? payload.key : undefined,
      scrollX: payload.type === 'scroll' ? payload.x : undefined,
      scrollY: payload.type === 'scroll' ? payload.y : undefined
    }
    this.send({ kind: 'interaction', interaction })
  }

  private recordConsoleEntry(details: ConsoleMessageDetails): void {
    if (this.consoleCount >= BROWSER_RECORDER_BUDGET.consoleMaxPerSession) {
      if (!this.capWarned) {
        this.capWarned = true
        this.send({
          kind: 'console',
          entry: {
            id: `${this.pageContext().browserPageId}:console:cap`,
            level: 'warning',
            message: `Recorder console cap reached (${BROWSER_RECORDER_BUDGET.consoleMaxPerSession} entries); further messages are dropped.`,
            source: 'orca-recorder',
            lineNumber: 0,
            page: this.pageContext(),
            startedAt: new Date().toISOString()
          }
        })
      }
      return
    }
    this.consoleCount += 1
    const entry: BrowserRecorderConsoleEntry = {
      id: `${this.pageContext().browserPageId}:console:${this.consoleCount}`,
      level: normalizeConsoleLevel(details.level),
      message: capConsoleMessage(details.message),
      source: capConsoleMessage(details.sourceId ?? ''),
      lineNumber: typeof details.lineNumber === 'number' ? details.lineNumber : 0,
      page: this.pageContext(),
      startedAt: new Date().toISOString()
    }
    this.send({ kind: 'console', entry })
  }

  private async emitNetworkSummary(): Promise<void> {
    const bridge = this.bridge
    if (!bridge) {
      return
    }
    try {
      const result = await bridge.networkLog(
        undefined,
        this.target.worktreeId,
        this.target.browserPageId
      )
      const entries = result?.entries ?? []
      if (entries.length === 0) {
        return
      }
      const summary = summarizeBrowserNetworkEntries(entries)
      const networkSummary: BrowserRecorderNetworkSummary = {
        id: `${this.pageContext().browserPageId}:network:${Date.now()}`,
        page: this.pageContext(),
        startedAt: new Date().toISOString(),
        ...summary
      }
      this.send({ kind: 'network-summary', summary: networkSummary })
    } catch {
      // Network log unavailable (session torn down) — skip the summary.
    }
  }

  private pageContext(): { browserPageId: string; url: string; title: string } {
    return (
      this.bridge?.getPageInfo(this.target.worktreeId, this.target.browserPageId) ?? {
        browserPageId: this.target.browserPageId ?? '',
        url: '',
        title: ''
      }
    )
  }
}

type ConsoleMessageDetails = {
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

function normalizeConsoleLevel(level: string): BrowserRecorderConsoleLevel {
  switch (level) {
    case 'info':
    case 'log':
      return 'log'
    case 'warning':
      return 'warning'
    case 'error':
      return 'error'
    default:
      return 'debug'
  }
}

function capConsoleMessage(message: string): string {
  return message.length > BROWSER_RECORDER_BUDGET.consoleMessageMaxLength
    ? `${message.slice(0, BROWSER_RECORDER_BUDGET.consoleMessageMaxLength)}…`
    : message
}
