// ---------------------------------------------------------------------------
// Browser action recorder (main)
//
// When enabled, every browser automation action routed through
// RuntimeBrowserCommands is wrapped with a before/after DOM fingerprint and
// page context, then streamed to the renderer as a BrowserRecorderAutomationAction
// so the browser pane can log "what was done, what changed, where".
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto'
import type { BrowserWindow } from 'electron'

import {
  BROWSER_RECORDER_ACTION_CHANNEL,
  BROWSER_RECORDER_BUDGET,
  type BrowserRecorderAutomationAction,
  type BrowserRecorderDomFingerprint
} from '../../shared/browser-recorder-automation'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import {
  DOM_FINGERPRINT_EXPRESSION,
  capText,
  diffFingerprints,
  extractBrowserActionTarget,
  sanitizeBrowserActionParams
} from './browser-action-recorder-utils'

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

  isEnabled(): boolean {
    return this.enabled
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
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
    const fingerprintAfter = bridge ? await this.captureFingerprint(bridge, worktreeId) : null
    const pageAfter = bridge?.getPageInfo(worktreeId) ?? null
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
    try {
      getWindow().webContents.send(BROWSER_RECORDER_ACTION_CHANNEL, action)
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
        inputs:
          typeof parsed.inputs === 'string'
            ? parsed.inputs.slice(0, BROWSER_RECORDER_BUDGET.fingerprintInputsMaxLength)
            : ''
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
