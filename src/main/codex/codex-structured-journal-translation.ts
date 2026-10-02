import { createCodexProviderActivityReader } from '../native-chat/agent-session-wire/provider-frame-activity'
import { CODEX_TOKEN_USAGE_METHOD } from './codex-subagent-activity'
import {
  CODEX_JOURNAL_ADMITTED,
  type CodexJournalTranslationAdmission,
  type CodexJournalTranslator,
  type CodexJournalTranslatorDeps
} from './codex-structured-journal-contracts'
import { settleCodexJournalSession } from './codex-structured-journal-settlement'
import {
  restoreCodexHistoryItem,
  restoreCodexJournalThread
} from './codex-structured-journal-translation-restore'
import { CodexJournalTurnBoundaries } from './codex-structured-journal-translation-turn-boundaries'
import { createCodexJournalTranslatorWriters } from './codex-structured-journal-translation-writers'
import { publishCodexTurnLifecycle } from './codex-structured-journal-translation-turns'
import { codexProviderRetryRowBody, isCodexProviderRetryFrame } from './codex-provider-retry-row'
import { createCodexThreadItemRouter } from './codex-structured-journal-thread-item-routing'
import { codexThreadStoppedRunning, readCodexTurnId } from './codex-structured-thread-facts'
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
    commands,
    subagents,
    attributionFor,
    genericFrames,
    items,
    compactions,
    goals,
    prompts
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
    commands,
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
        handleItem: (event) =>
          restoreCodexHistoryItem(event, {
            primaryThreadId: deps.primaryThreadId?.() ?? null,
            compactions,
            items,
            executions: subagents.executions
          }),
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
      // Host lifecycle only: the journal records this child's end once its exit is seen.
      if (event.type === 'end-unproven') {
        return CODEX_JOURNAL_ADMITTED
      }
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
          // The host saw the child go, not what Codex made of the turn: whether it was a person's
          // Stop is the journal's Stop event to say (`turnEndAfterStop`), else it is news.
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
      if (isCodexProviderRetryFrame(event)) {
        // Always journaled, like any error frame: each attempt is evidence, and its publish is
        // the activity the idle sweep reads.
        return publishActivity(
          event,
          genericFrames.appendFrameRow(event.threadId, event.params, {
            body: codexProviderRetryRowBody(event.params),
            classification: 'error-surface'
          })
        )
      }
      // A thread that stopped running settles no open turn: Codex clears `running`
      // on every error, and an open turn ends on its `turn/completed`. It releases
      // a send whose dispatch was never answered, which nothing else re-derives live.
      if (
        event.method === 'thread/status/changed' &&
        codexThreadStoppedRunning(event.params) &&
        event.threadId === (deps.primaryThreadId?.() ?? null)
      ) {
        primaryThreadStoppedRunning = true
        reportPrimaryThreadStoppedRunning()
      }
      // A turn-ending `error` is a row inside the turn it names; the failed
      // `turn/completed` Codex sends after it is that turn's end. The thread
      // status was read for state above and prints nothing.
      const unhandled = genericFrames.appendUnhandled(
        `notification:${event.method}`,
        event.params,
        event.threadId,
        { coveredByTypedTranslator: event.method === 'thread/status/changed' }
      )
      if (unhandled.accepted && event.method === 'error') {
        commands.errorShown(event.params)
      }
      return publishActivity(event, unhandled)
    },
    beginCommand: (command) => commands.begin(command),
    forgetCommand: (turnId) => commands.forget(turnId),
    commandProviderTurnId: (turnId) => commands.providerTurnId(turnId),
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
