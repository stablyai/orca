// OpenCode native-chat live reconciliation.
//
// Why: OpenCode keeps conversations in SQLite (~/.local/share/opencode/
// opencode.db) whose `part` rows MUTATE in place while the assistant streams —
// there is no append-only file to fs.watch. This polls the DB on a bounded
// re-read, emits an initial tail snapshot, then emits only delta frames: brand
// new messages append, mutated parts of an already-seen message re-emit under
// the SAME stable message id so clients dedup by id (replacing in place) and
// messages that age out of the window are simply no longer re-emitted (never a
// removal frame, so paged history already delivered stays intact).

import type { NativeChatMessage, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import type { NativeChatTranscriptSubscription } from './transcript-watch-contract'
import { createTranscriptWatchScheduler } from './transcript-watch-scheduler'
import {
  openCodeMessageSignature,
  readOpenCodeNativeChatTranscriptTail
} from './opencode-sqlite-transcript'

export type OpenCodeNativeChatState = {
  initialized: boolean
  errorNotified: boolean
  lastEmitted: Map<string, NativeChatMessage>
}

export function createOpenCodeNativeChatState(): OpenCodeNativeChatState {
  return { initialized: false, errorNotified: false, lastEmitted: new Map() }
}

export type ReconcileOpenCodeArgs = {
  dbPath: string
  sessionId: string
  /** Re-read window; appends/updates are detected inside this newest tail. */
  windowLimit: number
  state: OpenCodeNativeChatState
  onInitialSnapshot: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    error?: string
  ) => void
  onAppend: (messages: NativeChatMessage[]) => void
}

/** One reconcile poll: read the tail window, then emit new + mutated messages.
 *  Idempotent per content signature, so repeated polls with no change emit
 *  nothing and a mutated part re-emits its stable message id exactly once. */
export async function reconcileOpenCodeNativeChat(args: ReconcileOpenCodeArgs): Promise<void> {
  const { dbPath, sessionId, windowLimit, state } = args
  const result = await readOpenCodeNativeChatTranscriptTail({
    dbPath,
    sessionId,
    limit: windowLimit
  })

  if ('error' in result) {
    // A busy WAL is a transient writer/read race; keep the last good snapshot
    // and let the next scheduled poll retry without flipping the UI to error.
    if (result.retryable) {
      return
    }
    if (!result.notFound && !state.errorNotified) {
      state.errorNotified = true
      args.onInitialSnapshot([], false, 0, result.error)
    }
    return
  }

  if (!state.initialized) {
    state.initialized = true
    state.lastEmitted = new Map(result.messages.map((message) => [message.id, message]))
    args.onInitialSnapshot(result.messages, result.hasMore, result.beforeOffset)
    return
  }

  const updates: NativeChatMessage[] = []
  for (const message of result.messages) {
    const previous = state.lastEmitted.get(message.id)
    if (
      previous === undefined ||
      openCodeMessageSignature(previous) !== openCodeMessageSignature(message)
    ) {
      updates.push(message)
    }
  }
  if (updates.length > 0) {
    args.onAppend(updates)
  }
  // Why: bound state to the newest window so a long-running session does not
  // accumulate every emitted message in memory; messages that aged out are no
  // longer re-emitted (the client keeps its paged copy).
  state.lastEmitted = new Map(result.messages.map((message) => [message.id, message]))
}

// Why: 100 rounds up to a few medium assistant turns, includes every message
// that could still be streaming (the newest) and bounds the poll cost to a few
// hundred rows + their parts per tick at ~1 Hz.
const OPENCODE_RECONCILE_WINDOW_MAX_CAP = 100
const OPENCODE_RECONCILE_INTERVAL_MS = 1_000

export function subscribeOpenCodeNativeChatTranscript(args: {
  dbPath: string
  sessionId: string
  initialLimit?: number
  onAppend: (messages: NativeChatMessage[], lifecycle?: NativeChatTurnLifecycle) => void
  onInitialSnapshot?: (
    messages: NativeChatMessage[],
    hasMore: boolean,
    beforeOffset: number,
    error?: string,
    lifecycle?: NativeChatTurnLifecycle
  ) => void
  /** Test-only override for the reconcile cadence. */
  reconciliationIntervalMs?: number
}): NativeChatTranscriptSubscription {
  const requestedLimit =
    typeof args.initialLimit === 'number' && !Number.isNaN(args.initialLimit)
      ? Math.floor(args.initialLimit)
      : 40
  const limitedWindow = Math.max(
    1,
    Math.min(requestedLimit, OPENCODE_RECONCILE_WINDOW_MAX_CAP)
  )
  let closed = false
  const state = createOpenCodeNativeChatState()

  const emitInitial = args.onInitialSnapshot ?? (() => {})
  const emitAppend = args.onAppend

  async function poll(): Promise<void> {
    if (closed) {
      return
    }
    await reconcileOpenCodeNativeChat({
      dbPath: args.dbPath,
      sessionId: args.sessionId,
      windowLimit: limitedWindow,
      state,
      onInitialSnapshot: (messages, hasMore, beforeOffset, error) => {
        if (!closed) {
          emitInitial(messages, hasMore, beforeOffset, error)
        }
      },
      onAppend: (messages) => {
        if (!closed) {
          emitAppend(messages)
        }
      }
    })
  }

  let reading = false
  let pendingPoll = false

  async function runPoll(): Promise<void> {
    if (closed) {
      return
    }
    if (reading) {
      pendingPoll = true
      return
    }
    reading = true
    try {
      do {
        pendingPoll = false
        await poll()
      } while (pendingPoll && !closed)
    } finally {
      reading = false
    }
  }

  const scheduler = createTranscriptWatchScheduler({
    reconciliationIntervalMs: args.reconciliationIntervalMs ?? OPENCODE_RECONCILE_INTERVAL_MS,
    drain: () => void runPoll(),
    reconcile: runPoll
  })

  scheduler.startReconciliation()
  scheduler.scheduleEventDrain()

  return {
    watching: true,
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      scheduler.dispose()
    }
  }
}
