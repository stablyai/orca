// Browser action recorder — event recording with per-session caps.

import {
  BROWSER_RECORDER_BUDGET,
  BROWSER_RECORDER_DEFAULT_OPTIONS,
  type BrowserRecorderConsoleEntry,
  type BrowserRecorderInteraction,
  type BrowserRecorderNetworkRequest,
  type BrowserRecorderOptions,
  type BrowserRecorderStreamEvent
} from '../../shared/browser-recorder-automation'
import {
  compactOriginStack,
  redactPostData,
  redactRequestUrl,
  redactResponseText,
  type BrowserRecorderInteractionPayload,
  type BrowserRecorderRequestPayload
} from './browser-recorder-message-parsing'
import { isChallengeRequest, isConsoleNoise, requestKey } from './browser-recorder-event-filters'
import { capText } from './browser-action-recorder-utils'
import {
  ConsoleStreakBuffer,
  normalizeConsoleLevel,
  type ConsoleMessageDetails,
  type ConsoleStreakEntry
} from './browser-console-streak'
import type { BrowserRecorderPageSource } from './browser-recorder-page-source'
import type { BrowserRecorderWebRequestDetails } from './browser-recorder-web-request'

export class BrowserRecorderEventRecorder {
  private readonly consoleStreak = new ConsoleStreakBuffer()
  /** Which streams this session records; renderer toggles at runtime. */
  private options: BrowserRecorderOptions = { ...BROWSER_RECORDER_DEFAULT_OPTIONS }
  private interactionCount = 0
  private consoleCount = 0
  private requestCount = 0
  private capWarned = false
  private interactionCapWarned = false
  private requestCapWarned = false
  /** Id of the last interaction — requests triggered after it get linked. */
  private lastTriggerId: string | null = null
  /** url|method keys reported by the page hook (3s window, capped). */
  private readonly recentRequestKeys = new Map<string, number>()
  private readonly pendingWebRequestTimers = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly send: (event: BrowserRecorderStreamEvent) => void,
    private readonly pageSource: BrowserRecorderPageSource
  ) {}

  /** Call on session stop: cancels pending safety-net emissions. */
  dispose(): void {
    for (const timer of this.pendingWebRequestTimers) {
      clearTimeout(timer)
    }
    this.pendingWebRequestTimers.clear()
  }

  /**
   * Updates which streams are recorded mid-session. Disabling console drains
   * the streak buffer first so messages captured while it was enabled still
   * reach the log before new ones start being skipped.
   */
  setOptions(options: BrowserRecorderOptions): void {
    if (this.options.console && !options.console) {
      this.flushConsoleStreak()
    }
    this.options = options
  }

  recordInteraction(payload: BrowserRecorderInteractionPayload): void {
    // Why: storage writes and websocket frames are separate, toggleable
    // streams — skip them before touching the interaction counter so their
    // budget slots stay available for real clicks/typing when disabled.
    if (payload.type === 'storage' && !this.options.storage) {
      return
    }
    if (payload.type === 'ws' && !this.options.ws) {
      return
    }
    if (this.interactionCount >= BROWSER_RECORDER_BUDGET.interactionMaxPerSession) {
      if (!this.interactionCapWarned) {
        this.interactionCapWarned = true
        this.sendCapWarning(
          'interaction',
          `Recorder interaction cap reached (${BROWSER_RECORDER_BUDGET.interactionMaxPerSession} events); further manual interactions are dropped.`
        )
      }
      return
    }
    this.interactionCount += 1
    const page = this.pageSource.pageContext()
    const interaction: BrowserRecorderInteraction = {
      id: `${page.browserPageId}:interaction:${this.interactionCount}`,
      kind: payload.type,
      page,
      startedAt: new Date().toISOString(),
      x: payload.x,
      y: payload.y,
      target: payload.target,
      tagName: payload.tagName,
      element: payload.el,
      key: payload.type === 'keydown' ? payload.key : undefined,
      text: payload.type === 'type' ? payload.text : undefined,
      value: payload.type === 'change' ? payload.value : undefined,
      clipboardAction: payload.type === 'clipboard' ? payload.clipboardAction : undefined,
      clipboardText: payload.type === 'clipboard' ? payload.clipboardText : undefined,
      wsText: payload.type === 'ws' ? payload.wsText : undefined,
      storageKey: payload.type === 'storage' ? payload.storageKey : undefined,
      storageValue: payload.type === 'storage' ? payload.storageValue : undefined,
      selectText: payload.type === 'select_text' ? payload.selectText : undefined,
      scrollX: payload.type === 'scroll' ? payload.x : undefined,
      scrollY: payload.type === 'scroll' ? payload.y : undefined
    }
    this.lastTriggerId = interaction.id
    this.send({ kind: 'interaction', interaction })
  }

  async recordRequest(payload: BrowserRecorderRequestPayload): Promise<void> {
    if (!this.options.requests) {
      return
    }
    // Why: Turnstile/Cloudflare challenge traffic is page-level noise — its
    // token bodies are huge base64 blobs and carry no app-flow information.
    if (isChallengeRequest(payload.url ?? '', payload.origin ?? '')) {
      return
    }
    if (this.requestCount >= BROWSER_RECORDER_BUDGET.networkRequestMaxPerSession) {
      if (!this.requestCapWarned) {
        this.requestCapWarned = true
        this.sendCapWarning(
          'request',
          `Recorder request cap reached (${BROWSER_RECORDER_BUDGET.networkRequestMaxPerSession} requests); further requests are dropped.`
        )
      }
      return
    }
    this.requestCount += 1
    // Why: mark before the awaited DOM check so the 300ms safety net cannot
    // emit a duplicate bare record while the page evaluation is in flight.
    this.markRequestKey(payload.url ?? '', payload.method ?? 'GET')
    const page = this.pageSource.pageContext()
    const request: BrowserRecorderNetworkRequest = {
      id: `${page.browserPageId}:request:${this.requestCount}`,
      page,
      startedAt: new Date().toISOString(),
      method: payload.method ?? 'GET',
      url: redactRequestUrl(payload.url ?? ''),
      // Why: 'request details' is a separate toggle — with it off the log
      // keeps the request line (method/url/status) but drops the bodies.
      postData:
        this.options.requestDetails && payload.body && payload.body.length > 0
          ? redactPostData(payload.body, BROWSER_RECORDER_BUDGET.requestBodyMaxLength)
          : null,
      status: payload.status ?? null,
      durationMs: payload.durationMs ?? null,
      origin: payload.origin ?? null,
      triggeredBy: this.lastTriggerId,
      kind: payload.kind ?? 'xhr',
      response:
        this.options.requestDetails && payload.response && payload.response.length > 0
          ? capText(
              redactResponseText(payload.response),
              // Why: in-page head+tail truncation keeps ~8KB plus an omitted
              // marker; cap slightly above the base budget so the tail's last
              // rows survive the redaction pass.
              BROWSER_RECORDER_BUDGET.responseMaxLength + 300
            )
          : null,
      responseSize: this.options.requestDetails ? (payload.responseSize ?? 0) : 0,
      responseTruncated: this.options.requestDetails && payload.responseTruncated === true,
      responseSchema:
        this.options.requestDetails && payload.responseSchema === 'html' ? 'html' : 'text',
      screenChanged: await this.pageSource.screenChangedSinceLast()
    }
    this.send({ kind: 'network-request', request })
  }

  /**
   * Safety net for requests the page hook missed. Deduplicated against page
   * records by url|method within a short window; emission is delayed so the
   * richer page record (with body/origin) wins the race.
   */
  recordWebRequest(details: BrowserRecorderWebRequestDetails): void {
    if (!this.options.requests) {
      return
    }
    if (isChallengeRequest(details.url, '')) {
      return
    }
    const key = requestKey(details.url, details.method)
    if (this.recentRequestKeys.has(key)) {
      return
    }
    const timer = setTimeout(() => {
      this.pendingWebRequestTimers.delete(timer)
      if (this.recentRequestKeys.has(key)) {
        return
      }
      if (this.requestCount >= BROWSER_RECORDER_BUDGET.networkRequestMaxPerSession) {
        return
      }
      this.requestCount += 1
      const requestSequence = this.requestCount
      const page = this.pageSource.pageContext()
      void this.pageSource.screenChangedSinceLast().then((screenChanged) => {
        const request: BrowserRecorderNetworkRequest = {
          id: `${page.browserPageId}:request:${requestSequence}`,
          page,
          startedAt: new Date().toISOString(),
          method: details.method,
          url: redactRequestUrl(details.url),
          postData: null,
          status: details.statusCode > 0 ? details.statusCode : null,
          durationMs: null,
          origin: null,
          triggeredBy: this.lastTriggerId,
          kind: details.resourceType === 'subFrame' ? 'frame' : 'fetch',
          screenChanged
        }
        this.send({ kind: 'network-request', request })
      })
    }, 300)
    this.pendingWebRequestTimers.add(timer)
  }

  private markRequestKey(url: string, method: string): void {
    const now = Date.now()
    this.recentRequestKeys.set(requestKey(url, method), now)
    // Why: keep the window tight — it exists only to stop the webRequest
    // safety net from double-reporting a request the page hook already
    // delivered. A long TTL would swallow genuine follow-up requests to the
    // same URL (e.g. a report tab loading its data table right after the
    // toolbar), so drop keys once the 300ms safety-net delay has passed.
    for (const [key, at] of this.recentRequestKeys) {
      if (now - at > 350) {
        this.recentRequestKeys.delete(key)
      }
    }
    if (this.recentRequestKeys.size > 50) {
      const oldest = this.recentRequestKeys.keys().next().value
      if (oldest !== undefined) {
        this.recentRequestKeys.delete(oldest)
      }
    }
  }

  recordConsoleEntry(details: ConsoleMessageDetails, now = new Date().toISOString()): void {
    if (!this.options.console) {
      return
    }
    // Why: debug-level chatter and junk-shaped one-liners ("22", "1 false",
    // "[object Object]") dominate app console output — drop them so real
    // errors and warnings stay visible in the flow.
    if (isConsoleNoise(details)) {
      return
    }
    const completed = this.consoleStreak.push(details, now)
    if (completed) {
      this.flushConsoleStreak(completed)
    }
  }

  flushConsoleStreak(entry?: ConsoleStreakEntry): void {
    const streak = entry ?? this.consoleStreak.flush()
    if (!streak) {
      return
    }
    if (this.consoleCount >= BROWSER_RECORDER_BUDGET.consoleMaxPerSession) {
      if (!this.capWarned) {
        this.capWarned = true
        this.sendCapWarning(
          'console',
          `Recorder console cap reached (${BROWSER_RECORDER_BUDGET.consoleMaxPerSession} entries); further messages are dropped.`
        )
      }
      return
    }
    this.consoleCount += 1
    const page = this.pageSource.pageContext()
    const entryRecord: BrowserRecorderConsoleEntry = {
      id: `${page.browserPageId}:console:${this.consoleCount}`,
      level: normalizeConsoleLevel(streak.level),
      message: capText(streak.message, BROWSER_RECORDER_BUDGET.consoleMessageMaxLength),
      source: capText(streak.sourceId, 120),
      lineNumber: streak.lineNumber,
      // Why: the first stack frame names the throwing function; reuse the
      // request-origin compactor so format stays fn@file:line with redaction.
      stack: streak.stack ? (compactOriginStack(streak.stack, 140) ?? undefined) : undefined,
      repeatCount: streak.count,
      page,
      startedAt: streak.startedAt
    }
    this.send({ kind: 'console', entry: entryRecord })
  }

  private sendCapWarning(kind: 'interaction' | 'request' | 'console', message: string): void {
    this.send({
      kind: 'console',
      entry: {
        id: `${this.pageSource.pageContext().browserPageId}:${kind}:cap`,
        level: 'warning',
        message,
        source: 'orca-recorder',
        lineNumber: 0,
        repeatCount: 1,
        page: this.pageSource.pageContext(),
        startedAt: new Date().toISOString()
      }
    })
  }
}
