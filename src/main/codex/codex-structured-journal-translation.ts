import { createCodexProviderActivityReader } from '../native-chat/agent-session-wire/provider-frame-activity'
import {
  CODEX_TOKEN_USAGE_METHOD,
  readCodexNotificationThreadItem
} from './codex-subagent-activity'
import { CodexSubagentRoster } from './codex-subagent-roster'
import { readCodexThreadItem } from './codex-structured-item-translation'
import { CodexJournalGenericFrames } from './codex-structured-journal-generic-frames'
import { CodexJournalCompactions } from './codex-structured-journal-compactions'
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
  settleCodexJournalTurn
} from './codex-structured-journal-settlement'
import { createCodexOversizedNotificationSettler } from './codex-structured-journal-translation-frames'
import { restoreCodexJournalThread } from './codex-structured-journal-translation-restore'
import { CodexJournalActiveTurns } from './codex-structured-journal-translation-turn-state'
import { publishCodexTurnLifecycle } from './codex-structured-journal-translation-turns'
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
  const activeTurns = new CodexJournalActiveTurns()
  const compactions = new CodexJournalCompactions(deps.sink, (threadId) =>
    activeTurns.current(threadId)
  )
  const genericFrames = new CodexJournalGenericFrames(deps, (threadId) =>
    activeTurns.current(threadId)
  )
  const items = new CodexJournalItems(
    deps,
    (threadId) => activeTurns.current(threadId),
    (threadId, turnId) => genericFrames.suppress(threadId, turnId)
  )
  const settleOversizedNotification = createCodexOversizedNotificationSettler(deps, items)
  const prompts = new CodexJournalPrompts(deps, (threadId, itemId) =>
    items.detailFor(threadId, itemId)
  )
  const subagents = new CodexSubagentRoster({
    sink: deps.sink,
    primaryThreadId: () => deps.primaryThreadId?.() ?? null,
    activeTurn: (threadId) => activeTurns.current(threadId),
    ...(deps.subagentExecutions ? { executions: deps.subagentExecutions } : {})
  })
  const flushStreams = (): CodexJournalTranslationAdmission =>
    items.streams.flush() ? CODEX_JOURNAL_ADMITTED : { accepted: false, reason: 'backpressure' }
  let readActivity = createCodexProviderActivityReader()
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
          ordinals: items.ordinals
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
        activeTurns.clear()
        compactions.clear()
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
        return event.method === 'turn/started' ? startTurn(event) : completeTurn(event)
      }
      const compaction = compactions.handle(event)
      if (compaction) {
        return publishActivity(event, compaction)
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
        const subagentItem = readCodexNotificationThreadItem(event.params, readCodexThreadItem)
        // Null means the roster did not claim it; fall through to normal item
        // handling. Returning here unconditionally swallows every other item.
        const subagentAdmission = subagentItem
          ? subagents.handleItem({
              threadId: event.threadId,
              turnId: readCodexTurnId(event.params) ?? activeTurns.current(event.threadId),
              item: subagentItem
            })
          : null
        if (subagentAdmission) {
          // Not a bare return: the roster claiming the item must not skip the
          // turn-tail arm, which is the only publisher of its activity copy.
          return publishActivity(event, subagentAdmission)
        }
        const translated = items.handle(event)
        return publishActivity(
          event,
          translated.handled
            ? translated.admission
            : genericFrames.appendUnhandled(
                `notification:${event.method}`,
                event.params,
                event.threadId
              )
        )
      }
      return publishActivity(
        event,
        genericFrames.appendUnhandled(`notification:${event.method}`, event.params, event.threadId)
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
      subagents.dispose()
      activeTurns.clear()
      compactions.clear()
    }
  }

  function startTurn(
    event: Extract<CodexStructuredSessionEvent, { type: 'notification' }>
  ): CodexJournalTranslationAdmission {
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
      if (event.threadId === (deps.primaryThreadId?.() ?? null)) {
        readActivity = createCodexProviderActivityReader()
        deps.sink.setActivity?.(null)
      }
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
    // The roster is deliberately NOT swept here. `spawn_agent` children outlive
    // the turn that spawned them and go on reporting into the same group, so a
    // turn boundary is no evidence contact was lost — and `turn/completed` is
    // the only turn-end notification Codex sends, so an abort cannot be told
    // apart from a clean finish either. Only `settleSession` may write
    // `unverifiable`.
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
      if (event.threadId === (deps.primaryThreadId?.() ?? null)) {
        readActivity = createCodexProviderActivityReader()
        deps.sink.setActivity?.(null)
      }
    }
    return admission
  }
}
