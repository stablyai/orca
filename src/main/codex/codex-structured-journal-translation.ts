import { createCodexProviderActivityReader } from '../native-chat/agent-session-wire/provider-frame-activity'
import { CODEX_TOKEN_USAGE_METHOD } from './codex-subagent-activity'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission,
  type CodexJournalTranslator,
  type CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { settleCodexJournalSession } from './codex-structured-journal-settlement'
import { restoreCodexJournalThread } from './codex-structured-journal-translation-restore'
import { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import { createCodexJournalTranslatorWriters } from './codex-structured-journal-translation-writers'
import { publishCodexTurnLifecycle } from './codex-structured-journal-translation-turns'
import { readCodexProviderVerdict } from './codex-structured-journal-provider-verdicts'
import { createCodexThreadItemRouter } from './codex-structured-journal-thread-item-routing'
import { readCodexTurnId } from './codex-structured-thread-facts'
import type { CodexStructuredSessionEvent } from './codex-structured-session-adapter'

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
  const {
    activeTurns,
    turnScopes,
    subagents,
    attributionFor,
    genericFrames,
    items,
    compactions,
    goals,
    prompts,
    settleOversizedNotification
  } = createCodexJournalTranslatorWriters(deps)
  const flushStreams = (): CodexJournalTranslationAdmission =>
    items.streams.flush() ? CODEX_JOURNAL_ADMITTED : { accepted: false, reason: 'backpressure' }
  let readActivity = createCodexProviderActivityReader()
  const resetActivity = (threadId: string): void => {
    if (threadId === (deps.primaryThreadId?.() ?? null)) {
      readActivity = createCodexProviderActivityReader()
      deps.sink.setActivity?.(null)
    }
  }
  const turnBoundaries = new CodexJournalTurnBoundaries({
    sink: deps.sink,
    primaryThreadId: () => deps.primaryThreadId?.() ?? null,
    activeTurns,
    items,
    pendingPrompts: prompts.pending,
    ...(deps.clearPromptTurn ? { clearPromptTurn: deps.clearPromptTurn } : {}),
    flushSuppression: () => genericFrames.flush(),
    resetActivity,
    attributionFor,
    turnScopes,
    ...(deps.claimCommandTurn ? { claimCommandTurn: deps.claimCommandTurn } : {}),
    ...(deps.now ? { now: deps.now } : {})
  })
  let primaryThreadStoppedRunning = false
  const reportPrimaryThreadStoppedRunning = (): void => {
    const primaryThreadId = deps.primaryThreadId?.() ?? null
    if (!primaryThreadStoppedRunning || !primaryThreadId || activeTurns.current(primaryThreadId)) {
      return
    }
    primaryThreadStoppedRunning = false
    deps.onPrimaryThreadStoppedRunning?.()
  }
  const routeThreadItem = createCodexThreadItemRouter({
    deps,
    subagents,
    items,
    activeTurns,
    turnBoundaries,
    genericFrames
  })
  const publishActivity = (
    event: Extract<CodexStructuredSessionEvent, { type: 'notification' }>,
    admission: CodexJournalTranslationAdmission
  ): CodexJournalTranslationAdmission => {
    if (!admission.accepted || event.threadId !== (deps.primaryThreadId?.() ?? null)) {
      return admission
    }
    const turnId = readCodexTurnId(event.params) ?? activeTurns.current(event.threadId)
    if (!turnId) {
      return admission
    }
    const text = readActivity(event.method, event.params)
    if (text !== undefined) {
      deps.sink.setActivity?.(text ? { turnId, text } : null)
    }
    return admission
  }

  return {
    restoreThread: (threadId, thread) => {
      if (threadId === (deps.primaryThreadId?.() ?? null)) {
        readActivity = createCodexProviderActivityReader()
      }
      return restoreCodexJournalThread({
        threadId,
        thread,
        currentTurnIds: activeTurns.byThread,
        ordinals: items.ordinals,
        handleItem: (event) => {
          const compaction = compactions.handle(event)
          if (compaction) {
            return compaction
          }
          const translated = items.handle(event, 'history')
          return translated.handled
            ? translated.admission
            : { accepted: false, reason: 'untranslated' }
        },
        ...(deps.sessionId !== undefined
          ? {
              restoreTurnLifecycle: (turnLifecycle) =>
                publishCodexTurnLifecycle({
                  sink: deps.sink,
                  primaryThreadId: deps.primaryThreadId?.() ?? null,
                  sessionId: deps.sessionId as string,
                  threadId,
                  ...turnLifecycle
                })
            }
          : {}),
        flush: items.streams.flush
      })
    },
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
          ordinals: items.ordinals,
          // The host saw the child go, not what Codex made of the turn, so the row
          // carries no outcome: the end is observed, the verdict is unknown.
          settledTurnLifecycle: (threadId, turnId) =>
            turnBoundaries.ownsRecord(threadId, turnId)
              ? turnBoundaries.settled(threadId, turnId, {
                  state: 'interrupted',
                  completedAt: event.observedAt ?? deps.now?.() ?? Date.now()
                })
              : null,
          attributionFor
        })
        if (!admission.accepted) {
          return admission
        }
        // No event will ever settle a child once the provider is gone.
        const sweep = subagents.settleSession()
        if (!sweep.accepted) {
          return sweep
        }
        readActivity = createCodexProviderActivityReader()
        deps.sink.setActivity?.(null)
        items.activeItems.clear()
        prompts.pending.clear()
        turnBoundaries.clear()
        compactions.clear()
        goals.clear()
        return CODEX_JOURNAL_ADMITTED
      }
      if (event.type === 'notification') {
        const streamResult = items.streams.handle(event.threadId, event.method, event.params)
        if (streamResult.handled) {
          return publishActivity(event, streamResult.admission)
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
      if (event.method === 'turn/started' || event.method === 'turn/completed') {
        const childAdmission = subagents.handleTurnEvent(event)
        if (!childAdmission.accepted) {
          return childAdmission
        }
        const admission =
          event.method === 'turn/started'
            ? turnBoundaries.start(event)
            : turnBoundaries.complete(event)
        if (admission.accepted) {
          reportPrimaryThreadStoppedRunning()
        }
        return admission
      }
      const compaction = compactions.handle(event)
      if (compaction) {
        return publishActivity(event, compaction)
      }
      const goal = goals.handle(event)
      if (goal) {
        return publishActivity(event, goal)
      }
      if (event.method === CODEX_TOKEN_USAGE_METHOD) {
        // Classified `status-chrome`, so the generic-frame path swallows it
        // before the journal. The roster consumes it as a typed notification.
        const admission = subagents.handleTokenUsage(event.params)
        if (admission) {
          return admission
        }
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const routed = routeThreadItem(event)
        // Not a bare return: a claimed item must not skip the turn-tail arm,
        // which is the only publisher of its activity copy.
        if (routed) {
          return publishActivity(event, routed)
        }
      }
      const verdict = readCodexProviderVerdict(event.method, event.params)
      if (
        verdict === 'thread-stopped-running' &&
        event.threadId === (deps.primaryThreadId?.() ?? null)
      ) {
        primaryThreadStoppedRunning = true
        reportPrimaryThreadStoppedRunning()
      }
      // The row carries the provider's sentence and is written first, so it lands
      // inside the turn this same frame is about to end.
      const unhandled = genericFrames.appendUnhandled(
        `notification:${event.method}`,
        event.params,
        event.threadId
      )
      if (unhandled.accepted && verdict === 'turn-failed') {
        const failed = turnBoundaries.fail(event)
        if (!failed.accepted) {
          return failed
        }
        reportPrimaryThreadStoppedRunning()
      }
      return publishActivity(event, unhandled)
    },
    cancelPrompt: (journalItemId) => prompts.cancel(journalItemId),
    resolvePrompt: (journalItemId) => prompts.resolve(journalItemId),
    flush: () => {
      items.streams.flush()
      genericFrames.flush()
    },
    dispose: () => {
      items.dispose()
      prompts.dispose()
      genericFrames.dispose()
      subagents.dispose()
      turnBoundaries.clear()
      compactions.clear()
      goals.dispose()
    }
  }
}
