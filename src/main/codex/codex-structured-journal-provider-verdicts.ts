// What Codex's own verdict frames mean beyond the row they print.
//
// Both are decoration to the transcript and load-bearing to the session's state,
// which is why they are read here rather than left to the generic-frame fallback.

import { codexThreadStoppedRunning, readCodexErrorWillRetry } from './codex-structured-thread-facts'

export type CodexProviderVerdict =
  /**
   * Codex ended this turn with a fault.
   *
   * The app server emits `error` ONLY for a failure that affects turn status, and
   * hardcodes `willRetry: false` there; a stream error it is about to retry carries
   * `willRetry: true` and ends nothing. `turn/completed` may never follow, so this
   * frame is the turn's only end — without it the running lifecycle row is a latch
   * nothing re-derives and the chat reads working for the life of the session.
   */
  | 'turn-failed'
  /**
   * Codex reports the thread is no longer running.
   *
   * This settles no OPEN turn: the app server clears `running` on every error,
   * including the ones it says do not affect turn status, so a turn still open
   * here is still running and `turn/completed` is its end. What it does settle is
   * a send whose dispatch was never answered — a timed-out dispatch is recorded
   * as unverified delivery, reads as work still owed, and nothing else in a live
   * session re-derives it.
   */
  | 'thread-stopped-running'
  | null

export function readCodexProviderVerdict(method: string, params: unknown): CodexProviderVerdict {
  if (method === 'error') {
    return readCodexErrorWillRetry(params) ? null : 'turn-failed'
  }
  if (method === 'thread/status/changed') {
    return codexThreadStoppedRunning(params) ? 'thread-stopped-running' : null
  }
  return null
}
