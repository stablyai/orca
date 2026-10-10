import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'
import {
  claudeStreamingMessageBody,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import { claudeProviderFrameActivity } from '../native-chat/agent-session-wire/provider-frame-activity'
import {
  claudeProviderFrameKind,
  createClaudeProviderFrameFallback,
  isClaudeProgressFrame
} from './claude-structured-provider-fallback'
import { taskFrameSentence } from './claude-background-task-frames'
import { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'
import { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import { createClaudeStreamedThinking } from './claude-streamed-thinking'
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
import { ClaudeAuthenticationFailures } from './claude-authentication-failures'
import type { AgentSessionAccountKind } from '../../shared/agent-session-availability'

export type { ClaudeJournalTranslator } from './claude-journal-translator-contract'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
  onBackgroundTaskJournalFailure?: (error: Error) => void
  account?: () => AgentSessionAccountKind | undefined
}

export function createClaudeJournalTranslator(
  deps: ClaudeJournalTranslatorDeps
): ClaudeJournalTranslator {
  const tools = new Map<string, ClaudeToolUse>()
  // Every row joins the root turn open when it is written, whoever produced it.
  const turnScope = () => turn.turnScope
  const prompts = new ClaudeJournalPrompts({
    ...deps,
    turnScope,
    producerOf: (prompt) => childQueries.promptProducer(prompt)
  })
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  const turn = new ClaudeOpenTurn({
    sink: deps.sink,
    settleChildren: (groupKey) => subagents.settleTurn(groupKey),
    endOpenWork: (completedAt) => streamedThinking.finishOpen(completedAt),
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
  const streamedThinking = createClaudeStreamedThinking({
    ...deps,
    producer: subagents.linkage,
    turnScope
  })
  const flush = (): void => {
    streamedText.flush()
    streamedThinking.flush()
  }

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
    const delta = streamedBlocks.observe(message, observedAt)
    const thinking = streamedThinking.observe(message, observedAt)
    // `message_start` is the provider's turn boundary. Keep the first content
    // delta as a compatibility fallback for streams that omit it.
    const source =
      delta || thinking ? claudeStreamTurnSource(message) : claudeStreamTurnStartSource(message)
    turn.ensureOpen(message, source, observedAt)
    if (delta) {
      streamedText.append(delta.identity, delta.text, delta.parentToolUseId)
    }
    return delta !== null || thinking
  }

  const messageContext: ClaudeMessageJournalContext = {
    sink: deps.sink,
    tools,
    streamedBlocks,
    streamedText,
    streamedThinking,
    subagents,
    toolOrigins,
    backgroundTasks,
    providerFallback,
    corrections,
    turn,
    authenticationFailures: new ClaudeAuthenticationFailures(deps.account)
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
        flush()
        subagents.settleSession()
        backgroundTasks.settleSession()
        // The host saw the child end, so the turn's end is observed, not lost. Whether it was a
        // person's Stop is the journal's Stop event to say (`turnEndAfterStop`), else it is news.
        turn.settle({ state: 'interrupted', completedAt: event.observedAt ?? Date.now() })
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
      // Only ahead of a frame that can write a row: one per thinking token rewrote the whole row.
      if (!(event.type === 'message' && isClaudeProgressFrame(event.message))) {
        flush()
      }
      if (announced) {
        corrections.retry()
        streamedText.reattribute()
        streamedThinking.reattribute()
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
    get commandTurnId() {
      return turn.command ? turn.id : null
    },
    beginCommand: (start) => turn.beginCommand(claudeCommandCurrentTurn(start)),
    forgetCommand: (turnId) => turn.forgetCommand(turnId),
    commandInterruptRequested: (turnId) => turn.commandInterruptRequested(turnId),
    get openTurnInLiveProviderCycle() {
      return turn.openedInLiveProviderCycle
    },
    flush,
    childToolOwner: childQueries.childToolOwner,
    childActivity: childQueries.childActivity,
    retryPendingTaskRows: () => backgroundTasks.retryPendingWrites(),
    get pendingStreamedBlocks() {
      return streamedText.pending + streamedThinking.pending
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
      flush()
      context.dispose()
      streamedText.dispose()
      streamedThinking.dispose()
      tools.clear()
      prompts.clear()
      streamedBlocks.clear()
      subagents.dispose()
      backgroundTasks.dispose()
      toolOrigins.clear()
    }
  }
}
