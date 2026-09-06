import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import { CodexJournalItems } from './codex-structured-journal-items'
import { CodexJournalPrompts } from './codex-structured-journal-prompts'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission,
  type CodexJournalTranslator,
  type CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import {
  settleCodexJournalSession,
  settleCodexJournalTurn,
  settleCodexOversizedNotification
} from './codex-structured-journal-settlement'
import { restoreCodexJournalThread } from './codex-structured-journal-translation-restore'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { publishCodexTurnLifecycle } from './codex-structured-journal-translation-turns'
import {
  readCodexJournalRecord,
  readCodexJournalString
} from './codex-structured-journal-translation-values'
import { readCodexTurnId } from './codex-structured-thread-facts'

export type {
  CodexJournalTranslationAdmission,
  CodexJournalTranslator,
  CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
export {
  MAX_CODEX_ACTIVE_ITEMS,
  MAX_CODEX_DETAIL_BYTES,
  MAX_CODEX_DETAIL_ENTRIES,
  MAX_CODEX_GENERIC_BOOKKEEPING_BYTES,
  MAX_CODEX_GENERIC_BOOKKEEPING_ENTRIES,
  MAX_CODEX_GENERIC_ROWS_PER_TURN,
  MAX_CODEX_GENERIC_TURN_BUCKETS,
  MAX_CODEX_IDENTITY_ENTRIES,
  MAX_CODEX_PENDING_PROMPTS
} from './codex-structured-journal-limits'

export function createCodexJournalTranslator(
  deps: CodexJournalTranslatorDeps
): CodexJournalTranslator {
  const activeTurns = new CodexJournalActiveTurns()
  const genericFrames = new CodexJournalGenericFrames(deps, (threadId) =>
    activeTurns.current(threadId)
  )
  const items = new CodexJournalItems(
    deps,
    (threadId) => activeTurns.current(threadId),
    (threadId, turnId) => genericFrames.suppress(threadId, turnId)
  )
  const prompts = new CodexJournalPrompts(deps, (threadId, itemId) =>
    items.detailFor(threadId, itemId)
  )
  const flushStreams = (): CodexJournalTranslationAdmission =>
    items.streams.flush() ? CODEX_JOURNAL_ADMITTED : { accepted: false, reason: 'backpressure' }

  return {
    restoreThread: (threadId, thread) =>
      restoreCodexJournalThread({
        threadId,
        thread,
        currentTurnIds: activeTurns.byThread,
        ordinals: items.ordinals,
        handleItem: (event) => {
          const translated = items.handle(event)
          return translated.handled
            ? translated.admission
            : { accepted: false, reason: 'untranslated' }
        },
        flush: items.streams.flush
      }),
    handle: (event) => {
      if (event.type === 'ended') {
        const streamAdmission = flushStreams()
        if (!streamAdmission.accepted) {
          return streamAdmission
        }
        const suppressionAdmission = genericFrames.flush()
        if (!suppressionAdmission.accepted) {
          return suppressionAdmission
        }
        const admission = settleCodexJournalSession({
          event,
          sink: deps.sink,
          streams: items.streams,
          activeItems: items.activeItems,
          pendingPrompts: prompts.pending,
          currentTurnIds: activeTurns.byThread,
          primaryThreadId: deps.primaryThreadId?.() ?? null,
          ordinals: items.ordinals
        })
        if (!admission.accepted) {
          return admission
        }
        items.activeItems.clear()
        prompts.pending.clear()
        activeTurns.clear()
        return CODEX_JOURNAL_ADMITTED
      }
      if (event.type === 'notification') {
        const streamResult = items.streams.handle(event.threadId, event.method, event.params)
        if (streamResult.handled) {
          return streamResult.admission
        }
      }
      const streamAdmission = flushStreams()
      if (!streamAdmission.accepted) {
        return streamAdmission
      }
      if (event.type === 'prompt') {
        const suppressionAdmission = genericFrames.flush()
        return suppressionAdmission.accepted ? prompts.handle(event) : suppressionAdmission
      }
      if (event.type === 'server-request') {
        return genericFrames.appendUnhandled(
          `request:${event.method}`,
          event.params,
          event.threadId
        )
      }
      if (event.type === 'provider-frame') {
        const settlement = settleOversizedNotification(event)
        if (settlement && !settlement.accepted) {
          return settlement
        }
        return genericFrames.appendUnhandled(event.kind, event.payload, event.threadId)
      }
      if (event.method === 'turn/started') {
        return startTurn(event)
      }
      if (event.method === 'turn/completed') {
        return completeTurn(event)
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const translated = items.handle(event)
        return translated.handled
          ? translated.admission
          : genericFrames.appendUnhandled(
              `notification:${event.method}`,
              event.params,
              event.threadId
            )
      }
      return genericFrames.appendUnhandled(
        `notification:${event.method}`,
        event.params,
        event.threadId
      )
    },
    resolvePrompt: (journalItemId) => prompts.resolve(journalItemId),
    flush: () => {
      items.streams.flush()
      genericFrames.flush()
    },
    dispose: () => {
      items.dispose()
      prompts.dispose()
      genericFrames.dispose()
      activeTurns.clear()
    }
  }

  function settleOversizedNotification(event: {
    sessionId: string
    threadId: string
    kind: string
    payload: unknown
  }): CodexJournalTranslationAdmission | null {
    if (event.kind !== 'frame:oversized-notification') {
      return null
    }
    const method = readCodexJournalString(readCodexJournalRecord(event.payload), 'method')
    return method
      ? settleCodexOversizedNotification({
          sessionId: event.sessionId,
          threadId: event.threadId,
          method,
          sink: deps.sink,
          streams: items.streams,
          activeItems: items.activeItems
        })
      : null
  }

  function startTurn(event: {
    sessionId: string
    threadId: string
    params: unknown
  }): CodexJournalTranslationAdmission {
    const turnId = readCodexTurnId(event.params)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    if (!activeTurns.canRemember(event.threadId, turnId)) {
      return { accepted: false, reason: 'backpressure' }
    }
    const admission = publishCodexTurnLifecycle({
      sink: deps.sink,
      primaryThreadId: deps.primaryThreadId?.() ?? null,
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      state: 'running'
    })
    if (admission.accepted) {
      activeTurns.remember(event.threadId, turnId)
    }
    return admission
  }

  function completeTurn(event: {
    sessionId: string
    threadId: string
    params: unknown
  }): CodexJournalTranslationAdmission {
    const suppressionAdmission = genericFrames.flush()
    if (!suppressionAdmission.accepted) {
      return suppressionAdmission
    }
    const turnId = readCodexTurnId(event.params) ?? activeTurns.current(event.threadId)
    if (!turnId) {
      return CODEX_JOURNAL_ADMITTED
    }
    const admission = settleCodexJournalTurn({
      sink: deps.sink,
      sessionId: event.sessionId,
      threadId: event.threadId,
      turnId,
      streams: items.streams,
      activeItems: items.activeItems
    })
    if (admission.accepted) {
      items.ordinals.forgetTurn(event.threadId, turnId)
      activeTurns.forget(event.threadId, turnId)
    }
    return admission
  }
}
