import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import {
  claudeStreamingMessageBody,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { claudeProviderFrameActivity } from '../native-chat/agent-session-wire/provider-frame-activity'
import {
  claudeProviderFrameKind,
  claudeResultFailure,
  createClaudeProviderFrameFallback,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { taskFrameSentence } from './claude-background-task-frames'
import { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'
import { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import { ClaudeSubagentRoster } from './claude-subagent-roster'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeFrameParentRef,
  claudeStreamTurnStartSource,
  claudeStreamTurnSource,
  isRootClaudeFrame
} from './claude-turn-opening'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { ClaudeOpenTurn } from './claude-open-turn'
import { ClaudeContextFacts } from './claude-context-facts'
import { claudeSessionStateEndsTurn } from './claude-session-state-turn-over'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { claudeChildToolQueries } from './claude-child-tool-queries'
import { journalClaudeMessage, type ClaudeMessageJournalContext } from './claude-message-journaling'

export type { ClaudeJournalTranslator } from './claude-journal-translator-contract'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
  onBackgroundTaskJournalFailure?: (error: Error) => void
}

export function createClaudeSessionJournalTranslator(
  sink: StructuredAgentSessionEventSink | undefined,
  prompts: ClaudePromptRegistry,
  fallbackIdPrefix: string,
  onBackgroundTaskJournalFailure?: (error: Error) => void
): ClaudeJournalTranslator | null {
  return sink
    ? createClaudeJournalTranslator({
        sink,
        fallbackIdPrefix,
        ...(onBackgroundTaskJournalFailure ? { onBackgroundTaskJournalFailure } : {}),
        bindPromptItemId: (itemId, promptKey) => prompts.bindJournalItemId(itemId, promptKey)
      })
    : null
}

export function createClaudeJournalTranslator(
  deps: ClaudeJournalTranslatorDeps
): ClaudeJournalTranslator {
  const tools = new Map<string, ClaudeToolUse>()
  const prompts = new ClaudeJournalPrompts(deps)
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  const turn = new ClaudeOpenTurn({
    sink: deps.sink,
    settleChildren: (groupKey) => subagents.settleTurn(groupKey),
    onOpen: () => context.markActivity()
  })
  const context = new ClaudeContextFacts(turn, deps.sink)
  const providerFallback = createClaudeProviderFrameFallback(
    deps.sink,
    deps.fallbackIdPrefix ?? 'acquisition'
  )
  const toolOrigins = new ClaudeToolOriginRegistry()
  const subagents = new ClaudeSubagentRoster({
    sink: deps.sink,
    currentGroupKey: () => turn.groupKey,
    isForwardedParentTool: (toolUseId) => toolOrigins.has(toolUseId),
    childOwnerRefOf: (toolUseId) => toolOrigins.childOwnerRef(toolUseId),
    // A settled group can receive no further announcement, so a correction
    // still owed is never coming; the rows keep the stamp they already have.
    onIdentitiesFinal: () => corrections.abandon()
  })
  const childQueries = claudeChildToolQueries({ tools, toolOrigins, linkage: subagents.linkage })
  const corrections = new ClaudeProvisionalRowCorrections({
    ...subagents.linkage,
    rewrite: (identity, body, options) => {
      // The admission-returning path, so a correction the sink refuses under
      // backpressure stays owed instead of vanishing. Sinks without it accept
      // unconditionally, which is what the plain append already assumed.
      const admission = deps.sink.tryAppendItem?.(identity, body, options)
      if (admission === undefined) {
        deps.sink.appendItem(identity, body, options)
        return true
      }
      return admission.accepted
    },
    publish: () => deps.sink.publish()
  })
  const backgroundTasks = new ClaudeBackgroundTaskRows({
    sink: deps.sink,
    isForwardedParentTool: (toolUseId) => toolOrigins.has(toolUseId),
    // A typed task row is provider output: journaling one must open a resumed
    // turn, or the session shows the row while reading idle.
    openOutputTurn: (frame, observedAt) =>
      turn.ensureOpen(frame, claudeStreamTurnSource(frame), observedAt),
    ...(deps.onBackgroundTaskJournalFailure
      ? { onPersistenceFailure: deps.onBackgroundTaskJournalFailure }
      : {})
  })
  const streamedText = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: subagents.linkage,
    persist: (identity, text, options) => {
      deps.sink.appendItem(identity, claudeStreamingMessageBody(text), options)
      deps.sink.publish()
    }
  })

  const publishActivity = (kind: string, payload: unknown): void => {
    const turnId = turn.id
    if (turnId === null) {
      return
    }
    const text = claudeProviderFrameActivity(kind, payload)
    if (text !== undefined) {
      deps.sink.setActivity?.(text ? { turnId, text } : null)
    }
  }

  const handleStream = (message: Record<string, unknown>, observedAt: number): boolean => {
    const delta = streamedBlocks.observe(message)
    // `message_start` is the provider's turn boundary. Keep the first text
    // delta as a compatibility fallback for streams that omit it.
    const source = delta ? claudeStreamTurnSource(message) : claudeStreamTurnStartSource(message)
    turn.ensureOpen(message, source, observedAt)
    if (!delta) {
      return false
    }
    streamedText.append(delta.identity, delta.text, delta.parentToolUseId)
    return true
  }

  const messageContext: ClaudeMessageJournalContext = {
    sink: deps.sink,
    tools,
    streamedBlocks,
    streamedText,
    subagents,
    toolOrigins,
    backgroundTasks,
    providerFallback,
    corrections,
    turn
  }

  const handleMessage = (
    message: Record<string, unknown>,
    startsTurn: boolean,
    observedAt: number,
    requestedAt?: number
  ): boolean => journalClaudeMessage(messageContext, message, startsTurn, observedAt, requestedAt)

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        prompts.retryPendingCancellations()
        streamedText.flush()
        subagents.settleSession()
        backgroundTasks.settleSession()
        // The host saw the child end, so the turn's end is observed, not lost.
        turn.settle({ state: 'interrupted', completedAt: event.observedAt ?? Date.now() })
        // A frame that arrives after the child is gone must not open a turn no
        // event can close.
        turn.suppressReopen()
        return
      }
      if (event.type === 'message') {
        context.observe(event.message, event.observedAt ?? Date.now())
      }
      if (event.type === 'message' && handleStream(event.message, event.observedAt ?? Date.now())) {
        return
      }
      // Ahead of the flush: a forced checkpoint resolves attribution as it
      // writes, so an announcement landing in this same pass has to be visible
      // to it or the row is stamped provisionally one line too early.
      const announced = event.type === 'message' && subagents.observeSystemFrame(event.message)
      streamedText.flush()
      if (announced) {
        corrections.retry()
        streamedText.reattribute()
      }
      if (event.type === 'prompt') {
        prompts.handle(event)
      } else if (event.type === 'prompt-cancelled') {
        prompts.retryPendingCancellations()
        prompts.cancel(event.promptKey)
      } else if (event.type === 'message' && event.message.type === 'result') {
        // Every turn this translator opens is root by construction, so a nested
        // result settles the child that produced it and never the turn. The
        // diagnostic below still runs: a child's failure is reportable even when
        // it ends no turn.
        const settlesTurn = isRootClaudeFrame(event.message)
        if (settlesTurn) {
          prompts.retryPendingCancellations()
          turn.suppressReopenOnFailure(event.message.is_error === true)
          // The turn is over however it ended, so a foreground child still
          // reported as working will never be settled by an event.
          subagents.settleTurn(turn.groupKey)
          context.settle(
            event.message,
            claudeTurnEndForResult(event.message, event.observedAt ?? Date.now())
          )
          // The turn is over. A block still awaiting its final keeps the text the
          // flush above journaled, but its live state goes: an interrupted turn
          // would otherwise retain that text for the life of the session.
          streamedBlocks.clear()
          streamedText.settle()
        }
        const kind = claudeProviderFrameKind(event.message)
        const failure = claudeResultFailure(event.message)
        if (failure || !isSettledClaudeResultKind(kind)) {
          providerFallback.append(
            kind,
            event.message,
            failure?.text,
            undefined,
            undefined,
            // A result that settles no turn is a CHILD's result: this
            // translator only ever opens root turns.
            settlesTurn ? undefined : corrections.stampFor(claudeFrameParentRef(event.message))
          )
        }
      } else if (event.type === 'message') {
        const backgroundTaskCovered = backgroundTasks.observe(
          event.message,
          event.observedAt ?? Date.now()
        )
        const kind = claudeProviderFrameKind(event.message)
        if (
          !handleMessage(
            event.message,
            event.startsTurn === true,
            event.observedAt ?? Date.now(),
            event.requestedAt
          )
        ) {
          providerFallback.append(
            kind,
            event.message,
            taskFrameSentence(event.message),
            undefined,
            { coveredByTypedTranslator: backgroundTaskCovered },
            corrections.stampFor(claudeFrameParentRef(event.message))
          )
        }
        context.observeResponse(event.message, event.observedAt ?? Date.now())
        publishActivity(kind, event.message)
        // The CLI's own turn-over signal, and the only end a turn stopped by a
        // fault with no result frame ever gets. Reopen stays allowed: output
        // after an idle belongs to a turn, and suppressing it would read as
        // idle while the agent works.
        if (claudeSessionStateEndsTurn(event.message)) {
          subagents.settleTurn(turn.groupKey)
          // No verdict: the CLI said the turn is over, not how it ended.
          turn.settle({ state: 'completed', completedAt: event.observedAt ?? Date.now() })
        }
      } else if (event.type === 'provider-frame') {
        providerFallback.append(event.kind, event.payload)
        publishActivity(event.kind, event.payload)
      }
    },
    journalPrompts: prompts,
    get currentTurnId() {
      return turn.id
    },
    flush: streamedText.flush,
    childToolOwner: childQueries.childToolOwner,
    childActivity: childQueries.childActivity,
    retryPendingTaskRows: () => backgroundTasks.retryPendingWrites(),
    get pendingStreamedBlocks() {
      return streamedText.pending
    },
    get contextActivity() {
      return context.activityRevision
    },
    markContextActivity: () => context.markActivity(),
    subscribeContextUsageRequests: (listener) => context.subscribeReportRequests(listener),
    recordContextReport: (target, report, part) => context.recordReport(target, report, part),
    modelMayHaveChanged: () => context.modelMayHaveChanged(),
    modelWritten: (model) => context.modelWritten(model),
    dispose: () => {
      streamedText.flush()
      context.dispose()
      streamedText.dispose()
      tools.clear()
      prompts.clear()
      streamedBlocks.clear()
      subagents.dispose()
      backgroundTasks.dispose()
      toolOrigins.clear()
    }
  }
}
