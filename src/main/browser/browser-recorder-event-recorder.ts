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

export class BrowserRecorderEventRecorder {
  private readonly consoleStreak = new ConsoleStreakBuffer()
  private interactionCount = 0
  private consoleCount = 0
  private requestCount = 0
  private capWarned = false
  private interactionCapWarned = false
  private requestCapWarned = false

  constructor(
    private readonly send: (event: BrowserRecorderStreamEvent) => void,
    private readonly pageSource: BrowserRecorderPageSource
  ) {}

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
      key: payload.type === 'keydown' ? payload.key : undefined,
      text: payload.type === 'type' ? payload.text : undefined,
      scrollX: payload.type === 'scroll' ? payload.x : undefined,
      scrollY: payload.type === 'scroll' ? payload.y : undefined
    }
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
      screenChanged: await this.pageSource.screenChangedSinceLast()
    }
    this.send({ kind: 'network-request', request })
  }

  recordConsoleEntry(details: ConsoleMessageDetails, now = new Date().toISOString()): void {
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
