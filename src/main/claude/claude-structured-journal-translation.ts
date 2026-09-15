import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
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
import { ClaudeForwardedToolRegistry } from './claude-forwarded-tool-registry'
import { ClaudeSubagentRoster } from './claude-subagent-roster'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeStreamTurnStartSource,
  claudeStreamTurnSource,
  createClaudeTurnOpener,
  isRootClaudeFrame
} from './claude-turn-opening'
import {
  claudeTurnEndForResult,
  claudeTurnLifecycleItem,
  type ClaudeCurrentTurn,
  type ClaudeTurnEnd
} from './claude-turn-lifecycle-item'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'
import { journalClaudeMessage, type ClaudeMessageJournalContext } from './claude-message-journaling'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string, questionId?: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
}

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  journalPrompts: Pick<ClaudeJournalPrompts, 'cancel' | 'resolve'>
  flush: () => void
  /** Streamed blocks still awaiting a final frame. A settled turn leaves none. */
  readonly pendingStreamedBlocks: number
  dispose: () => void
}

export function createClaudeSessionJournalTranslator(
  sink: StructuredAgentSessionEventSink | undefined,
  prompts: ClaudePromptRegistry,
  fallbackIdPrefix: string
): ClaudeJournalTranslator | null {
  return sink
    ? createClaudeJournalTranslator({
        sink,
        fallbackIdPrefix,
        bindPromptItemId: (itemId, promptKey, questionId) =>
          prompts.bindJournalItemId(itemId, promptKey, questionId)
      })
    : null
}

export function createClaudeJournalTranslator(
  deps: ClaudeJournalTranslatorDeps
): ClaudeJournalTranslator {
  const tools = new Map<string, ClaudeToolUse>()
  const prompts = new ClaudeJournalPrompts(deps)
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  let currentTurn: ClaudeCurrentTurn | null = null
  /** Provider output may not reopen a turn after the session ended or a turn
   *  failed: nothing would ever close the turn it opened, and the row would read
   *  working for the life of the session. Only an accepted send lifts it. */
  let reopenSuppressed = false
  const groupKeyOf = (turn: ClaudeCurrentTurn | null): string | null =>
    turn ? `${turn.sessionId}:${turn.turnId}` : null
  const providerFallback = createClaudeProviderFrameFallback(
    deps.sink,
    deps.fallbackIdPrefix ?? 'acquisition'
  )
  const subagents = new ClaudeSubagentRoster({
    sink: deps.sink,
    currentGroupKey: () => groupKeyOf(currentTurn)
  })
  const forwardedTools = new ClaudeForwardedToolRegistry()
  const backgroundTasks = new ClaudeBackgroundTaskRows({
    sink: deps.sink,
    isForwardedParentTool: (toolUseId) => forwardedTools.has(toolUseId),
    // A typed task row is provider output: journaling one must open a resumed
    // turn, or the session shows the row while reading idle.
    openOutputTurn: (frame, observedAt) =>
      ensureTurnOpen(frame, claudeStreamTurnSource(frame), observedAt)
  })
  const streamedText = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    persist: (identity, text) => {
      deps.sink.appendItem(identity, claudeStreamingMessageBody(text))
      deps.sink.publish()
    }
  })

  const publishLifecycle = (turn: ClaudeCurrentTurn, end?: ClaudeTurnEnd): void => {
    const item = claudeTurnLifecycleItem(turn, end)
    deps.sink.appendItem(item.identity, item.body, item.options)
    deps.sink.publish({ coalescingKey: item.publishCoalescingKey })
  }

  /** Open a turn, ending whichever one was still open. A new turn starting is the
   *  only end the previous one gets when its result never arrives; settling it
   *  later would sweep THIS turn. */
  const openTurn = (turn: ClaudeCurrentTurn, observedAt: number): void => {
    if (currentTurn) {
      subagents.settleTurn(groupKeyOf(currentTurn))
      publishLifecycle(currentTurn, { state: 'interrupted', completedAt: observedAt })
    }
    currentTurn = turn
    publishLifecycle(turn)
    deps.sink.setActivity?.(null)
  }

  /** The provider produced, so a turn is running. Idempotent: every frame of one
   *  reply stays inside the turn its first frame opened. A subagent's output is
   *  its parent turn's work and never a turn of its own. */
  const ensureTurnOpen = createClaudeTurnOpener({
    isTurnOpen: () => currentTurn !== null,
    isSuppressed: () => reopenSuppressed,
    open: openTurn
  })

  const publishActivity = (kind: string, payload: unknown): void => {
    if (!currentTurn) {
      return
    }
    const text = claudeProviderFrameActivity(kind, payload)
    if (text !== undefined) {
      deps.sink.setActivity?.(text ? { turnId: currentTurn.turnId, text } : null)
    }
  }

  const handleStream = (message: Record<string, unknown>, observedAt: number): boolean => {
    const delta = streamedBlocks.observe(message)
    // `message_start` is the provider's turn boundary. Keep the first text
    // delta as a compatibility fallback for streams that omit it.
    const source = delta ? claudeStreamTurnSource(message) : claudeStreamTurnStartSource(message)
    ensureTurnOpen(message, source, observedAt)
    if (!delta) {
      return false
    }
    streamedText.append(delta.identity, delta.text)
    return true
  }

  const messageContext: ClaudeMessageJournalContext = {
    sink: deps.sink,
    tools,
    streamedBlocks,
    streamedText,
    subagents,
    forwardedTools,
    providerFallback,
    ensureTurnOpen,
    openTurn,
    liftSuppression: () => {
      reopenSuppressed = false
    }
  }

  const handleMessage = (
    message: Record<string, unknown>,
    startsTurn: boolean,
    observedAt: number
  ): boolean => journalClaudeMessage(messageContext, message, startsTurn, observedAt)

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        prompts.retryPendingCancellations()
        streamedText.flush()
        subagents.settleSession()
        backgroundTasks.settleSession()
        if (currentTurn) {
          publishLifecycle(currentTurn, {
            state: 'interrupted',
            completedAt: event.observedAt ?? Date.now()
          })
          currentTurn = null
        }
        // A frame that arrives after the child is gone must not open a turn no
        // event can close.
        reopenSuppressed = true
        deps.sink.setActivity?.(null)
        return
      }
      if (event.type === 'message' && handleStream(event.message, event.observedAt ?? Date.now())) {
        return
      }
      streamedText.flush()
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
          // The turn is over however it ended, so a foreground child still
          // reported as working will never be settled by an event.
          // A turn that failed, or that the user stopped, is not resumed by
          // whatever the provider says next; the next send is what resumes it.
          // The latch only ever sets here; an accepted send is what lifts it.
          reopenSuppressed ||= event.message.is_error === true
          subagents.settleTurn(groupKeyOf(currentTurn))
          if (currentTurn) {
            publishLifecycle(
              currentTurn,
              claudeTurnEndForResult(event.message, event.observedAt ?? Date.now())
            )
            currentTurn = null
          }
          deps.sink.setActivity?.(null)
          // The turn is over. A block still awaiting its final keeps the text the
          // flush above journaled, but its live state goes: an interrupted turn
          // would otherwise retain that text for the life of the session.
          streamedBlocks.clear()
          streamedText.settle()
        }
        const kind = claudeProviderFrameKind(event.message)
        const failure = claudeResultFailure(event.message)
        if (failure || !isSettledClaudeResultKind(kind)) {
          providerFallback.append(kind, event.message, failure?.text)
        }
      } else if (event.type === 'message') {
        subagents.observeSystemFrame(event.message)
        const backgroundTaskCovered = backgroundTasks.observe(
          event.message,
          event.observedAt ?? Date.now()
        )
        const kind = claudeProviderFrameKind(event.message)
        if (
          !handleMessage(event.message, event.startsTurn === true, event.observedAt ?? Date.now())
        ) {
          providerFallback.append(
            kind,
            event.message,
            taskFrameSentence(event.message),
            undefined,
            { coveredByTypedTranslator: backgroundTaskCovered }
          )
        }
        publishActivity(kind, event.message)
      } else if (event.type === 'provider-frame') {
        providerFallback.append(event.kind, event.payload)
        publishActivity(event.kind, event.payload)
      }
    },
    journalPrompts: prompts,
    flush: streamedText.flush,
    get pendingStreamedBlocks() {
      return streamedText.pending
    },
    dispose: () => {
      streamedText.dispose()
      tools.clear()
      prompts.clear()
      streamedBlocks.clear()
      subagents.dispose()
      backgroundTasks.dispose()
      forwardedTools.clear()
    }
  }
}
