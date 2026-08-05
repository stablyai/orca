// ---------------------------------------------------------------------------
// Browser action recorder — page source probe
//
// Wraps the bridge for the observer's per-event needs: current page context,
// DOM screen-change detection after a response lands, and the stop-time
// network summary. Best-effort: any failure yields empty/null, never throws.
// ---------------------------------------------------------------------------

import type {
  BrowserRecorderDomChangeKind,
  BrowserRecorderDomFingerprint,
  BrowserRecorderNetworkSummary
} from '../../shared/browser-recorder-automation'
import type { AgentBrowserBridge } from './agent-browser-bridge'
import { DOM_FINGERPRINT_EXPRESSION } from './browser-page-capture-expressions'
import {
  diffFingerprints,
  parseInputsDetail,
  summarizeBrowserNetworkEntries
} from './browser-action-recorder-utils'

export type BrowserActionRecorderTarget = {
  worktreeId?: string
  browserPageId?: string
}

export class BrowserRecorderPageSource {
  private readonly bridge: AgentBrowserBridge | null
  private readonly target: BrowserActionRecorderTarget
  private lastFingerprint: BrowserRecorderDomFingerprint | null = null

  constructor(bridge: AgentBrowserBridge | null, target: BrowserActionRecorderTarget) {
    this.bridge = bridge
    this.target = target
  }

  pageContext(): { browserPageId: string; url: string; title: string } {
    return (
      this.bridge?.getPageInfo(this.target.worktreeId, this.target.browserPageId) ?? {
        browserPageId: this.target.browserPageId ?? '',
        url: '',
        title: ''
      }
    )
  }

  /** DOM change kinds observed since the previous check (throttled by callers). */
  async screenChangedSinceLast(): Promise<BrowserRecorderDomChangeKind[]> {
    if (!this.bridge) {
      return []
    }
    try {
      const evalResult = await this.bridge.evaluate(
        DOM_FINGERPRINT_EXPRESSION,
        this.target.worktreeId,
        this.target.browserPageId
      )
      const parsed = JSON.parse(evalResult.result) as Partial<BrowserRecorderDomFingerprint>
      const fingerprint: BrowserRecorderDomFingerprint = {
        url: typeof parsed.url === 'string' ? parsed.url : '',
        title: typeof parsed.title === 'string' ? parsed.title : '',
        textLength: typeof parsed.textLength === 'number' ? parsed.textLength : 0,
        interactive: typeof parsed.interactive === 'number' ? parsed.interactive : 0,
        inputsDetail: parseInputsDetail(parsed.inputsDetail),
        bodyText: typeof parsed.bodyText === 'string' ? parsed.bodyText : undefined
      }
      if (!this.lastFingerprint) {
        this.lastFingerprint = fingerprint
        return []
      }
      const diff = diffFingerprints(this.lastFingerprint, fingerprint)
      this.lastFingerprint = fingerprint
      return diff.changed
    } catch {
      return []
    }
  }

  /** Traffic summary from the agent-browser network log, or null when empty. */
  async networkSummary(): Promise<BrowserRecorderNetworkSummary | null> {
    const bridge = this.bridge
    if (!bridge) {
      return null
    }
    try {
      const result = await bridge.networkLog(
        undefined,
        this.target.worktreeId,
        this.target.browserPageId
      )
      const entries = result?.entries ?? []
      if (entries.length === 0) {
        return null
      }
      const summary = summarizeBrowserNetworkEntries(entries)
      return {
        id: `${this.pageContext().browserPageId}:network:${Date.now()}`,
        page: this.pageContext(),
        startedAt: new Date().toISOString(),
        ...summary
      }
    } catch {
      return null
    }
  }
}
