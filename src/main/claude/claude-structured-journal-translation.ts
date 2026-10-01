import {
  childEndCauseOfEndedEvent,
  turnVerdictForChildEnd
} from '../native-chat/agent-session-wire/structured-agent-session-stale-turn-verdict'
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
  createClaudeProviderFrameFallback
} from './claude-structured-provider-fallback'
import { taskFrameSentence } from './claude-background-task-frames'
import { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'
import { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import { ClaudeSubagentRoster } from './claude-subagent-roster'
import { ClaudeJournaledRoster } from './claude-subagent-journaled-roster'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeFrameParentRef,
  claudeStreamTurnStartSource,
  claudeStreamTurnSource,
  isRootClaudeFrame
} from './claude-turn-opening'
import { ClaudeOpenTurn } from './claude-open-turn'
import { claudeCommandCurrentTurn, observeClaudeCommandFrame } from './claude-command-turn'
import { ClaudeContextFacts } from './claude-context-facts'
import { claudeSessionStateEndsTurn } from './claude-session-state-turn-over'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { claudeChildToolQueries } from './claude-child-tool-queries'
import { journalClaudeMessage, type ClaudeMessageJournalContext } from './claude-message-journaling'
import { journalClaudeResult, type ClaudeResultJournalContext } from './claude-result-journaling'

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
  // Every row joins the root turn open when it is written, whoever produced it.
  const turnScope = () => turn.turnScope
  const prompts = new ClaudeJournalPrompts({ ...deps, turnScope })
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  const turn = new ClaudeOpenTurn({
    sink: deps.sink,
    settleChildren: (groupKey) => subagents.settleTurn(groupKey),
    onOpen: () => context.markActivity()
  })
  const context = new ClaudeContextFacts(turn, deps.sink)
  const fallbackId = deps.fallbackIdPrefix ?? 'acquisition'
  const providerFallback = createClaudeProviderFrameFallback(deps.sink, fallbackId, turnScope)
  const toolOrigins = new ClaudeToolOriginRegistry()
  const journaled = new ClaudeJournaledRoster(() => deps.sink.journalLinkage?.() ?? null)
  const subagents = new ClaudeSubagentRoster({
    sink: deps.sink,
    currentGroupKey: () => turn.groupKey,
    currentTurnScope: turnScope,
    isForwardedParentTool: (toolUseId) => toolOrigins.has(toolUseId),
    childOwnerRefOf: (toolUseId) => toolOrigins.childOwnerRef(toolUseId),
    // A restarted provider continues the roster earlier runs journaled.
    journaled,
    // A settled group can receive no further announcement, so a correction
    // still owed is never coming; the rows keep the stamp they already have.
    onIdentitiesFinal: () => corrections.abandon()
  })
  const childQueries = claudeChildToolQueries({ tools, toolOrigins, linkage: subagents.linkage })
  const corrections = new ClaudeProvisionalRowCorrections({
    ...subagents.linkage,
    turnScope,
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
    rosteredByEarlierRun: (taskId) => journaled.groupOf(taskId) !== null,
    // A typed task row is provider output: journaling one must open a resumed
    // turn, or the session shows the row while reading idle.
    openOutputTurn: (frame, observedAt) =>
      turn.ensureOpen(frame, claudeStreamTurnSource(frame), observedAt),
    turnScope,
    ...(deps.onBackgroundTaskJournalFailure
      ? { onPersistenceFailure: deps.onBackgroundTaskJournalFailure }
      : {})
  })
  const streamedText = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    producer: subagents.linkage,
    persist: (identity, text, options) => {
      const body = claudeStreamingMessageBody(text)
      deps.sink.appendItem(identity, body, { ...options, turnScope: turnScope() })
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

  const resultContext: ClaudeResultJournalContext = { ...messageContext, prompts, context }

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
        // The host saw the child end, so the turn's end is observed, not lost; its verdict is only
        // what the host's own cause says, a user's stop of this chat or else news.
        turn.settle(
          turnVerdictForChildEnd(childEndCauseOfEndedEvent(event), event.observedAt ?? Date.now())
        )
        // A frame that arrives after the child is gone must not open a turn no
        // event can close.
        turn.suppressReopen()
        return
      }
      if (event.type === 'message') {
        context.observe(event.message, event.observedAt ?? Date.now())
        // A root init is the CLI starting a new request cycle (measured per turn,
        // per queued turn, per background wake, per /compact); a send replayed
        // after that cycle's first root work was folded into it. Task frames are
        // not cycle work: they arrive between cycles too.
        if (isRootClaudeFrame(event.message)) {
          if (event.message.type === 'system' && event.message.subtype === 'init') {
            turn.observeProviderCycleStart()
          } else if (
            event.startsTurn === true ||
            event.message.type === 'assistant' ||
            event.message.type === 'stream_event'
          ) {
            turn.observeProviderCycleWork()
          }
        }
      }
      if (event.type === 'message' && observeClaudeCommandFrame(turn.command, event.message)) {
        return
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
        journalClaudeResult(resultContext, event.message, event.observedAt ?? Date.now())
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
    recordTurnStop: (turnId, cause) => turn.recordStop(turnId, cause),
    withdrawTurnStop: (turnId) => turn.withdrawStop(turnId),
    get commandTurnId() {
      return turn.command ? turn.id : null
    },
    beginCommand: (start) => turn.beginCommand(claudeCommandCurrentTurn(start)),
    forgetCommand: (turnId) => turn.forgetCommand(turnId),
    commandInterruptRequested: (turnId) => turn.commandInterruptRequested(turnId),
    get openTurnInLiveProviderCycle() {
      return turn.openedInLiveProviderCycle
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
