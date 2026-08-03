// ---------------------------------------------------------------------------
// Browser action recorder — console streak buffer
//
// Coalesces consecutive identical page console messages into a single entry
// with a repeat count, so noisy apps (SPAs logging every AJAX response) cannot
// flood the recording log.
// ---------------------------------------------------------------------------

import type { BrowserRecorderConsoleLevel } from '../../shared/browser-recorder-automation'

export type ConsoleMessageDetails = {
  level: string
  message: string
  lineNumber: number
  sourceId: string
}

export type ConsoleStreakEntry = {
  level: string
  message: string
  sourceId: string
  lineNumber: number
  count: number
  startedAt: string
}

export function normalizeConsoleLevel(level: string): BrowserRecorderConsoleLevel {
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

export class ConsoleStreakBuffer {
  private streak: (ConsoleStreakEntry & { key: string }) | null = null

  /** Feeds one console message; returns the completed streak to emit, if any. */
  push(details: ConsoleMessageDetails, now = new Date().toISOString()): ConsoleStreakEntry | null {
    const key = `${details.level}|${details.message}|${details.sourceId}`
    if (this.streak && this.streak.key === key) {
      this.streak.count += 1
      return null
    }
    const completed = this.flush()
    this.streak = {
      key,
      level: details.level,
      message: details.message,
      sourceId: details.sourceId,
      lineNumber: details.lineNumber,
      count: 1,
      startedAt: now
    }
    return completed
  }

  /** Returns and clears the pending streak, or null when empty. */
  flush(): ConsoleStreakEntry | null {
    const streak = this.streak
    this.streak = null
    if (!streak) {
      return null
    }
    const { key: _key, ...entry } = streak
    return entry
  }
}
