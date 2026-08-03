// ---------------------------------------------------------------------------
// Browser action recorder — event recording
//
// Turns parsed interaction/request payloads and console streaks into stream
// events, enforcing per-session caps with a one-time cap warning per stream.
// ---------------------------------------------------------------------------

import {
  BROWSER_RECORDER_BUDGET,
  type BrowserRecorderConsoleEntry,
  type BrowserRecorderInteraction,
  type BrowserRecorderNetworkRequest,
  type BrowserRecorderStreamEvent
} from '../../shared/browser-recorder-automation'
import {
  redactPostData,
  redactRequestUrl,
  type BrowserRecorderInteractionPayload,
  type BrowserRecorderRequestPayload
} from './browser-recorder-message-parsing'
import { capText } from './browser-action-recorder-utils'
import {
  ConsoleStreakBuffer,
  normalizeConsoleLevel,
  type ConsoleMessageDetails,
  type ConsoleStreakEntry
} from './browser-console-streak'
import type { BrowserRecorderPageSource } from './browser-recorder-page-source'
import type { BrowserRecorderWebRequestDetails } from './browser-recorder-web-request'

function requestKey(url: string, method: string): string {
  // Why: the page hook reports relative URLs while webRequest reports
  // absolute ones — normalize both to path+search so dedup matches.
  try {
    const parsed = new URL(url, 'http://localhost')
    return `${method}|${parsed.pathname}${parsed.search}`
  } catch {
    return `${method}|${url}`
  }
}

/** Filters app console chatter so real messages stay visible. */
function isConsoleNoise(details: ConsoleMessageDetails): boolean {
  if (details.level === 'debug') {
    return true
  }
  const message = (details.message ?? '').trim()
  if (message.length < 3) {
    return true
  }
  if (message === '[object Object]') {
    return true
  }
  // "1 null", "42 false" — app-internal counter reports.
  if (/^\d+\s+(null|false|true|undefined)$/i.test(message)) {
    return true
  }
  return false
}

export class BrowserRecorderEventRecorder {
  private readonly consoleStreak = new ConsoleStreakBuffer()
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

  recordInteraction(payload: BrowserRecorderInteractionPayload): void {
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
      scrollX: payload.type === 'scroll' ? payload.x : undefined,
      scrollY: payload.type === 'scroll' ? payload.y : undefined
    }
    this.lastTriggerId = interaction.id
    this.send({ kind: 'interaction', interaction })
  }

  async recordRequest(payload: BrowserRecorderRequestPayload): Promise<void> {
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
    const page = this.pageSource.pageContext()
    const request: BrowserRecorderNetworkRequest = {
      id: `${page.browserPageId}:request:${this.requestCount}`,
      page,
      startedAt: new Date().toISOString(),
      method: payload.method ?? 'GET',
      url: redactRequestUrl(payload.url ?? ''),
      postData:
        payload.body && payload.body.length > 0
          ? redactPostData(payload.body, BROWSER_RECORDER_BUDGET.requestBodyMaxLength)
          : null,
      status: payload.status ?? null,
      durationMs: payload.durationMs ?? null,
      origin: payload.origin ?? null,
      triggeredBy: this.lastTriggerId,
      kind: payload.kind ?? 'xhr',
      screenChanged: await this.pageSource.screenChangedSinceLast()
    }
    this.markRequestKey(payload.url ?? '', payload.method ?? 'GET')
    this.send({ kind: 'network-request', request })
  }

  /**
   * Safety net for requests the page hook missed. Deduplicated against page
   * records by url|method within a short window; emission is delayed so the
   * richer page record (with body/origin) wins the race.
   */
  recordWebRequest(details: BrowserRecorderWebRequestDetails): void {
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
      const page = this.pageSource.pageContext()
      void this.pageSource.screenChangedSinceLast().then((screenChanged) => {
        this.markRequestKey(details.url, details.method)
        const request: BrowserRecorderNetworkRequest = {
          id: `${page.browserPageId}:request:${this.requestCount}`,
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
    // Why: keep the window bounded — drop keys older than 3s.
    for (const [key, at] of this.recentRequestKeys) {
      if (now - at > 3000) {
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
