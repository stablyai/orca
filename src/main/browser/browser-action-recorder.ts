// ---------------------------------------------------------------------------
// Browser action recorder (main)
//
// When enabled, every browser automation action routed through
// RuntimeBrowserCommands is wrapped with a before/after DOM fingerprint and
// page context, then streamed to the renderer as a BrowserRecorderStreamEvent
// so the browser pane can log "what was done, what changed, where". While the
// session is active, a BrowserRecorderSessionObserver also captures manual
// page interactions, console output, and a stop-time network summary.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

import {
  BROWSER_RECORDER_ACTION_CHANNEL,
  BROWSER_RECORDER_BUDGET,
  BROWSER_RECORDER_DEFAULT_OPTIONS,
  type BrowserRecorderAutomationAction,
  type BrowserRecorderDomFingerprint,
  type BrowserRecorderOptions,
  type BrowserRecorderStreamEvent
} from '../../shared/browser-recorder-automation'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { DOM_FINGERPRINT_EXPRESSION } from './browser-page-capture-expressions'
import {
  NAVIGATION_METHODS,
  capText,
  diffFingerprints,
  extractBrowserActionTarget,
  parseInputsDetail,
  sanitizeBrowserActionParams
} from './browser-action-recorder-utils'
import {
  BrowserRecorderSessionObserver,
  type BrowserActionRecorderTarget,
  type BrowserRecorderObserverHookInput
} from './browser-recorder-observer'

export type BrowserActionRecorderCaptureOptions = {
  method: string
  params: Record<string, unknown>
  worktreeId?: string
  browserPageId?: string
  getBridge: () => AgentBrowserBridge | null
  getWindow: () => BrowserWindow
  run: () => Promise<unknown>
}

export class BrowserActionRecorder {
  private enabled = false
  private observer: BrowserRecorderSessionObserver | null = null
  private observerWindowGetter: (() => BrowserWindow | undefined) | null = null

  isEnabled(): boolean {
    return this.enabled
  }

  /** Updates which streams the active session records (no-op when idle). */
  setOptions(options: BrowserRecorderOptions): void {
    this.observer?.setOptions(options)
  }

  /**
   * Enables or disables the recorder. When enabling with a target, a session
   * observer is started (interactions/console/network); disabling stops it.
   * Hooks are only required when a session observer should run. Returns false
   * when enabling could not attach to the target page (fail-closed toggle).
   */
  setEnabled(
    enabled: boolean,
    target: BrowserActionRecorderTarget = {},
    hooks?: BrowserRecorderObserverHookInput,
    options: BrowserRecorderOptions = { ...BROWSER_RECORDER_DEFAULT_OPTIONS }
  ): boolean {
    if (this.enabled === enabled) {
      if (enabled && this.observer) {
        this.observer.setOptions(options)
      }
      return enabled ? this.observer != null : true
    }
    this.enabled = enabled
    if (enabled) {
      this.observerWindowGetter = hooks?.getWindow ?? null
      this.observer = new BrowserRecorderSessionObserver(
        {
          getBridge: hooks?.getBridge ?? (() => null),
          getWindow: hooks?.getWindow ?? (() => undefined),
          send: (event) => this.sendEvent(event)
        },
        target,
        options
      )
      const attached = this.observer.start()
      if (!attached) {
        this.observer = null
        this.enabled = false
      }
      return attached
    }
    const observer = this.observer
    this.observer = null
    void observer?.stop()
    return true
  }

  /**
   * Runs `run` while recording the action and its result. Returns the action's
   * result and re-throws its error unchanged; recording is best-effort and
   * never alters the action's outcome.
   */
  async capture(options: BrowserActionRecorderCaptureOptions): Promise<unknown> {
    // Why: defense in depth — the runtime wrapper also gates, but capture must
    // never add fingerprint latency when the recorder is off.
    if (!this.enabled) {
      return options.run()
    }
    const { method, params, worktreeId, browserPageId, getBridge, getWindow, run } = options
    const bridge = getBridge()
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    const pageBefore = bridge?.getPageInfo(worktreeId, browserPageId) ?? null
    const fingerprintBefore = bridge
      ? await this.captureFingerprint(bridge, worktreeId, browserPageId)
      : null

    let ok = true
    let error: string | null = null
    let thrown: unknown = null
    let result: unknown
    try {
      result = await run()
    } catch (err) {
      ok = false
      thrown = err
      error = capText(
        err instanceof Error ? err.message : String(err),
        BROWSER_RECORDER_BUDGET.errorMaxLength
      )
      result = undefined
    }

    await this.buildAndSend(
      {
        method,
        params,
        worktreeId,
        browserPageId,
        getWindow,
        startedAt,
        startedMs,
        ok,
        error,
        pageBefore,
        fingerprintBefore
      },
      bridge
    )

    if (!ok) {
      throw thrown
    }
    return result
  }

  private async buildAndSend(
    context: {
      method: string
      params: Record<string, unknown>
      worktreeId?: string
      browserPageId?: string
      getWindow: () => BrowserWindow
      startedAt: string
      startedMs: number
      ok: boolean
      error: string | null
      pageBefore: { browserPageId: string; url: string; title: string } | null
      fingerprintBefore: BrowserRecorderDomFingerprint | null
    },
    bridge: AgentBrowserBridge | null
  ): Promise<void> {
    const {
      method,
      params,
      worktreeId,
      browserPageId,
      getWindow,
      startedAt,
      startedMs,
      ok,
      error,
      pageBefore,
      fingerprintBefore
    } = context
    const durationMs = Date.now() - startedMs
    // Why: probe the same page the action targeted — without browserPageId the
    // after-state can come from a different (active) page and diff wrong.
    const fingerprintAfter = bridge
      ? await this.captureFingerprint(bridge, worktreeId, browserPageId)
      : null
    const pageAfter = bridge?.getPageInfo(worktreeId, browserPageId) ?? null
    const action: BrowserRecorderAutomationAction = {
      id: randomUUID(),
      method,
      target: extractBrowserActionTarget(params),
      params: sanitizeBrowserActionParams(method, params),
      page: {
        browserPageId: pageBefore?.browserPageId ?? browserPageId ?? '',
        url: pageBefore?.url ?? '',
        title: pageBefore?.title ?? ''
      },
      startedAt,
      durationMs,
      ok,
      error,
      urlAfter: fingerprintAfter?.url || pageAfter?.url || null,
      titleAfter: fingerprintAfter?.title || pageAfter?.title || null,
      domDiff:
        fingerprintBefore && fingerprintAfter
          ? diffFingerprints(fingerprintBefore, fingerprintAfter)
          : null
    }
    this.sendEvent({ kind: 'action', action }, getWindow)

    // Why: navigation replaces the page, so the interaction listener/script
    // must re-attach to the new document (and possibly new webContents).
    if (NAVIGATION_METHODS.has(method)) {
      this.observer?.rearm()
    }
  }

  private sendEvent(event: BrowserRecorderStreamEvent, getWindow?: () => BrowserWindow): void {
    try {
      const window = getWindow?.() ?? this.observerWindowGetter?.()
      window?.webContents.send(BROWSER_RECORDER_ACTION_CHANNEL, event)
    } catch {
      // Window may be gone during shutdown — the log entry is simply not shown.
    }
  }

  private async captureFingerprint(
    bridge: AgentBrowserBridge,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserRecorderDomFingerprint | null> {
    try {
      const evalResult = await bridge.evaluate(
        DOM_FINGERPRINT_EXPRESSION,
        worktreeId,
        browserPageId
      )
      const parsed = JSON.parse(evalResult.result) as Partial<BrowserRecorderDomFingerprint>
      return {
        url: typeof parsed.url === 'string' ? parsed.url : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        textLength: typeof parsed.textLength === 'number' ? parsed.textLength : 0,
        interactive: typeof parsed.interactive === 'number' ? parsed.interactive : 0,
        inputsDetail: parseInputsDetail(parsed.inputsDetail),
        bodyText: typeof parsed.bodyText === 'string' ? parsed.bodyText : undefined
      }
    } catch {
      // Page mid-navigation or debugger busy — fingerprint is best-effort.
      return null
    }
  }
}

/** App-wide recorder instance; enabled/disabled from the renderer via IPC. */
export const browserActionRecorder = new BrowserActionRecorder()

export {
  extractBrowserActionTarget,
  isFullyRedactedBrowserMethod,
  isRecordedBrowserMethod,
  sanitizeBrowserActionParams
} from './browser-action-recorder-utils'
