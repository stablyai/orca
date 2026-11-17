import { ClaudeTaskInvocations } from '../../background-tasks/claude-task-invocations'
import { ClaudeJournalBoundDelivery } from './claude-journal-bound-delivery'
import type * as contract from './claude-journal-translator-contract'
import {
  claudeStreamingMessageBody,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import { publishClaudeTurnActivity } from '../turns/claude-turn-activity'
import {
  claudeProviderFrameKind,
  createClaudeProviderFrameFallback,
  isClaudeProgressFrame
} from '../launch/claude-structured-provider-fallback'
import { ClaudeBackgroundTaskRows } from '../../background-tasks/claude-background-task-rows'
import { ClaudeToolOriginRegistry } from '../../subagents/claude-tool-origin-registry'
import { ClaudeProvisionalRowCorrections } from '../../subagents/claude-provisional-row-corrections'
import { createClaudeStreamedThinking } from './claude-streamed-thinking'
import { ClaudeSubagentIdentities } from '../../subagents/claude-subagent-identities'
import { ClaudeJournaledSubagents } from '../../subagents/claude-subagent-journaled-identities'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeFrameParentRef,
  claudeStreamTurnSource,
  isRootClaudeFrame
} from '../turns/claude-turn-opening'
import { ClaudeOpenTurn } from '../turns/claude-open-turn'
import { absorbClaudeCommandFrame, claudeCommandCurrentTurn } from '../turns/claude-command-turn'
import { ClaudeContextFacts } from '../../context-usage/claude-context-facts'
import { claudeSessionStateEndsTurn } from '../turns/claude-session-state-turn-over'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { claudeChildToolQueries } from '../../subagents/claude-child-tool-queries'
import { journalClaudeMessage, journalClaudeStream } from './claude-message-journaling'
import type { ClaudeMessageJournalContext } from './claude-message-journaling'
import { journalClaudeResult } from './claude-result-journaling'
import type { ClaudeResultJournalContext } from './claude-result-journaling'
import { ClaudeAssistantFailures } from './claude-assistant-failures'
import { ClaudeUsageLimits } from './claude-usage-limits'
import { ClaudeThreadGoal } from './claude-thread-goal'
import { createClaudeFinalOutputCoverage } from './claude-final-output-coverage'
import { withClaudeConversationContent } from './claude-internal-message-content'
import {
  journalClaudePluginInputFailure,
  settleClaudeInterruptedTurn
} from './claude-plugin-input-failure-journal'

export function createClaudeJournalTranslator(
  deps: contract.ClaudeJournalTranslatorDeps
): contract.ClaudeJournalTranslator {
  const coverage = createClaudeFinalOutputCoverage(deps.sink)
  deps = { ...deps, sink: coverage.sink }
  const delivery = deps.delivery ?? new ClaudeJournalBoundDelivery(deps.sink)
  const tools = new Map<string, ClaudeToolUse>()
  const turnScope = () => turn.turnScope
  const prompts = new ClaudeJournalPrompts({
    ...deps,
    turnScope,
    producerOf: (prompt) => childQueries.promptProducer(prompt)
  })
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  const turn = new ClaudeOpenTurn({
    sink: deps.sink,
    // Keep existing stamps when superseding a turn ends pending attribution corrections.
    turnSuperseded: () => corrections.abandon(),
    endOpenWork: (completedAt) => streamedThinking.finishOpen(completedAt),
    onOpen: () => context.markActivity()
  })
  const context = new ClaudeContextFacts(turn, deps.sink)
  const fallbackId = deps.fallbackIdPrefix ?? 'acquisition'
  const providerFallback = createClaudeProviderFrameFallback(deps.sink, fallbackId, turnScope)
  const toolOrigins = new ClaudeToolOriginRegistry()
  const journaled = new ClaudeJournaledSubagents(() => deps.sink.journalLinkage?.() ?? null)
  const taskInvocations = new ClaudeTaskInvocations(journaled)
  const subagents = new ClaudeSubagentIdentities({
    taskInvocations,
    isForwardedParentTool: (toolUseId) => toolOrigins.has(toolUseId),
    childOwnerRefOf: (toolUseId) => toolOrigins.childOwnerRef(toolUseId),
    journaled
  })
  const childQueries = claudeChildToolQueries({ tools, toolOrigins, linkage: subagents.linkage })
  const corrections = new ClaudeProvisionalRowCorrections({
    ...subagents.linkage,
    turnScope,
    rewrite: (identity, body, options) => {
      // Keep refused corrections pending under backpressure; legacy sinks accept unconditionally.
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
    rosteredByEarlierRun: journaled.isSubagent,
    taskInvocations,
    // Task output must open a resumed turn so the session does not appear idle while producing rows.
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
    persist: (identity, text, options, ended) => {
      const body = claudeStreamingMessageBody(text)
      deps.sink.appendItem(identity, body, {
        ...options,
        turnScope: turnScope(),
        ...(ended ? { lifecycle: true } : {})
      })
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
    assistantFailures: new ClaudeAssistantFailures(deps.account, deps.model),
    usageLimits: new ClaudeUsageLimits(),
    threadGoal: new ClaudeThreadGoal(() => deps.sink.journalLinkage?.()?.threadGoalSource())
  }

  const resultContext: ClaudeResultJournalContext = {
    ...messageContext,
    prompts,
    context,
    goalBackgroundWork: deps.goalBackgroundWork ?? (() => 'unverifiable'),
    acceptStartupFailure: deps.acceptStartupFailure
  }

  const finish = (observedAt: number, failed: boolean): void => {
    prompts.retryPendingCancellations()
    flush()
    corrections.abandon()
    backgroundTasks.settleSession()
    settleClaudeInterruptedTurn(turn, observedAt, failed)
  }
  const handle = withClaudeConversationContent((event) => {
    if (event.type === 'retiring') {
      journalClaudePluginInputFailure({ event, turn, sink: deps.sink, finish })
      return
    }
    if (event.type === 'ended') {
      finish(event.observedAt ?? Date.now(), event.failure?.kind === 'pluginInputRequired')
      return
    }
    turn.observeStartedSend(event.type === 'message' ? (event.startedSend ?? null) : null)
    if (event.type === 'message') {
      context.observe(event.message, event.observedAt ?? Date.now())
      // Root init starts a cycle; replays after root work fold into it, while task frames do not mark cycle work.
      if (isRootClaudeFrame(event.message)) {
        if (event.message.type === 'system' && event.message.subtype === 'init') {
          turn.observeProviderCycleStart()
        } else if (
          event.startsTurn === true ||
          event.message.type === 'assistant' ||
          event.message.type === 'stream_event'
        ) {
          turn.observeProviderCycleWork()
          turn.inputChoiceWorkObserved ||=
            event.message.type !== 'assistant' ||
            event.message.is_api_error_message !== true ||
            event.startedSend != null
        }
      }
    }
    if (event.type === 'message' && absorbClaudeCommandFrame(messageContext, event.message)) {
      return
    }
    if (
      event.type === 'message' &&
      journalClaudeStream(messageContext, event.message, event.observedAt ?? Date.now())
    ) {
      return
    }
    // Observe announcements before flushing so buffered rows receive their resolved producer stamp.
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
      backgroundTasks.observe(event.message, event.observedAt ?? Date.now())
      messageContext.usageLimits.observe(event.message, turn.command?.rejections)
      const kind = claudeProviderFrameKind(event.message)
      if (
        !journalClaudeMessage(
          messageContext,
          event.message,
          event.startsTurn === true,
          event.observedAt ?? Date.now(),
          event.requestedAt,
          event.clientMessageId
        )
      ) {
        providerFallback.append(
          kind,
          event.message,
          undefined,
          undefined,
          undefined,
          corrections.stampFor(claudeFrameParentRef(event.message))
        )
      }
      context.observeResponse(event.message, event.observedAt ?? Date.now())
      publishClaudeTurnActivity(turn, deps.sink, event)
      // Idle also closes faults without a result; the live cause decides failed reopening.
      if (claudeSessionStateEndsTurn(event.message)) {
        corrections.abandon()
        // No verdict: the CLI said the turn is over, not how it ended.
        turn.settle({ state: 'completed', completedAt: event.observedAt ?? Date.now() })
      }
    } else if (event.type === 'provider-frame') {
      providerFallback.append(event.kind, event.payload)
      publishClaudeTurnActivity(turn, deps.sink, event)
    }
  })
  return {
    handle: (event) => delivery.interpret(event, handle),
    journalPrompts: prompts,
    get currentTurnId() {
      return turn.id
    },
    currentTurnScope: turnScope,
    get commandTurnId() {
      return turn.command ? turn.id : null
    },
    beginCommand: (start) => turn.beginCommand(claudeCommandCurrentTurn(start)),
    forgetCommand: (turnId) => turn.forgetCommand(turnId),
    commandInterruptRequested: (turnId) => turn.commandInterruptRequested(turnId),
    get openTurnInLiveProviderCycle() {
      return turn.openedInLiveProviderCycle
    },
    get openTurnHasInputWork() {
      return turn.isOpen && turn.inputChoiceWorkObserved
    },
    flush,
    taskInvocations,
    childTaskParent: subagents.parentOf,
    childToolOwner: childQueries.childToolOwner,
    childActivity: childQueries.childActivity,
    retryPendingTaskRows: () => backgroundTasks.retryPendingWrites(),
    retryPendingCancellations: () => prompts.retryPendingCancellations(),
    get pendingStreamedBlocks() {
      return streamedText.pending + streamedThinking.pending
    },
    get contextActivity() {
      return context.activityRevision
    },
    get finalOutputAdmitted() {
      return coverage.admitted
    },
    subscribeContextUsageRequests: (listener) => context.subscribeReportRequests(listener),
    recordContextReport: (target, report, askedAt) => context.recordReport(target, report, askedAt),
    modelMayHaveChanged: () => context.modelMayHaveChanged(),
    modelWritten: (model) => context.modelWritten(model),
    dispose: () => {
      delivery.dispose()
      flush()
      context.dispose()
      streamedText.dispose()
      streamedThinking.dispose()
      tools.clear()
      prompts.clear()
      streamedBlocks.clear()
      corrections.abandon()
      subagents.dispose()
      backgroundTasks.dispose()
      toolOrigins.clear()
    }
  }
}
