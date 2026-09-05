import type { CodexAppServerConnection } from './codex-app-server-connection'
import type { CodexJournalTranslationAdmission } from './codex-structured-journal-translation'
import type { CodexSession } from './codex-structured-session-state'

const MAX_RETRY_EVENTS = 256
const MAX_RETRY_BYTES = 8 * 1024 * 1024
const RETRY_DELAY_MS = 25

type PendingNotification = { method: string; params: unknown; bytes: number }
type RetryState = {
  connection: CodexAppServerConnection
  events: PendingNotification[]
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
  running: boolean
  failed: boolean
}

export function createCodexStructuredNotificationRetry(deps: {
  sessionFor: (sessionId: string) => CodexSession | undefined
  translate: (
    sessionId: string,
    session: CodexSession,
    method: string,
    params: unknown
  ) => CodexJournalTranslationAdmission
}) {
  const states = new Map<string, RetryState>()

  const retry = (sessionId: string, connection: CodexAppServerConnection): void => {
    const state = states.get(sessionId)
    if (!state || state.connection !== connection || state.running) {
      return
    }
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    state.running = true
    try {
      while (state.events.length > 0) {
        const pending = state.events[0]
        if (!pending) {
          break
        }
        const session = deps.sessionFor(sessionId)
        if (!session || session.connection !== connection || session.ended) {
          fail(sessionId, state, 'notification retry owner is no longer live')
          break
        }
        const admission = deps.translate(sessionId, session, pending.method, pending.params)
        if (!admission.accepted) {
          if (admission.reason === 'backpressure') {
            state.timer = setTimeout(() => {
              state.timer = null
              retry(sessionId, connection)
            }, RETRY_DELAY_MS)
            state.timer.unref?.()
          } else {
            fail(sessionId, state, `notification admission failed (${admission.reason})`)
          }
          break
        }
        state.events.shift()
        state.bytes = Math.max(0, state.bytes - pending.bytes)
      }
      if (state.events.length === 0) {
        states.delete(sessionId)
      }
    } finally {
      state.running = false
    }
  }

  const fail = (sessionId: string, state: RetryState, reason: string): void => {
    if (state.failed) {
      return
    }
    state.failed = true
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
    // The queue is no longer replayable. Drop it explicitly, release the read
    // pause, and enter the adapter's generation-checked unexpected-exit seam.
    state.events.length = 0
    state.bytes = 0
    state.connection.resumeReading?.()
    states.delete(sessionId)
    const session = deps.sessionFor(sessionId)
    if (session?.connection === state.connection) {
      void session.forceCloseUnexpected?.(new Error(reason))
    }
  }

  const enqueue = (
    sessionId: string,
    connection: CodexAppServerConnection,
    method: string,
    params: unknown
  ): void => {
    const bytes = Buffer.byteLength(JSON.stringify({ method, params }), 'utf8')
    let state = states.get(sessionId)
    if (!state || state.connection !== connection) {
      state = { connection, events: [], bytes: 0, timer: null, running: false, failed: false }
      states.set(sessionId, state)
    }
    if (state.events.length >= MAX_RETRY_EVENTS || state.bytes + bytes > MAX_RETRY_BYTES) {
      // A bounded queue cannot retain more traffic. Fail it truthfully so the
      // provider's generation enters host recovery instead of stranding a pause.
      fail(sessionId, state, 'notification retry queue overflow')
      return
    }
    state.events.push({ method, params, bytes })
    state.bytes += bytes
    connection.pauseReading?.()
  }

  return {
    handle: (
      sessionId: string,
      method: string,
      params: unknown
    ): CodexJournalTranslationAdmission => {
      const session = deps.sessionFor(sessionId)
      if (!session) {
        return { accepted: true }
      }
      const state = states.get(sessionId)
      if (state && state.events.length > 0) {
        enqueue(sessionId, state.connection, method, params)
        retry(sessionId, state.connection)
        return { accepted: false, reason: 'backpressure' }
      }
      const admission = deps.translate(sessionId, session, method, params)
      if (!admission.accepted) {
        enqueue(sessionId, session.connection, method, params)
        retry(sessionId, session.connection)
      }
      return admission
    },
    retry,
    clear: (sessionId: string, connection: CodexAppServerConnection | null): void => {
      const state = states.get(sessionId)
      if (!state || (connection && state.connection !== connection)) {
        return
      }
      if (state.timer) {
        clearTimeout(state.timer)
      }
      state.events.length = 0
      state.bytes = 0
      state.connection.resumeReading?.()
      states.delete(sessionId)
    }
  }
}

export type CodexStructuredNotificationRetry = ReturnType<
  typeof createCodexStructuredNotificationRetry
>
