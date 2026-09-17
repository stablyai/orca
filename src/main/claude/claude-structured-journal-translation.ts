import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentSessionDeltaCoalescerDeps } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { ClaudeStructuredSessionEvent } from './claude-structured-session-state'
import {
  claudeMessageBody,
  claudeMessageIdentity,
  claudeOutputEnvelope,
  claudeStreamingMessageBody,
  claudeThinkingIdentity,
  claudeThinkingText,
  claudeToolBody,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import type { ClaudePromptRegistry } from './claude-structured-prompt-replies'
import { claudeProviderFrameActivity } from '../native-chat/agent-session-wire/provider-frame-activity'
import {
  appendUnmodeledContent,
  claudeProviderFrameKind,
  claudeResultFailure,
  createClaudeProviderFrameFallback,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { ClaudeSubagentRoster } from './claude-subagent-roster'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import {
  claudeStreamTurnStartSource,
  claudeStreamTurnSource,
  claudeTurnOpenedBySendEcho,
  isRootClaudeFrame,
  type ClaudeTurnSource
} from './claude-turn-opening'
import { claudeTurnEndForResult } from './claude-turn-lifecycle-item'
import { ClaudeOpenTurn } from './claude-open-turn'
import { ClaudeJournalPrompts } from './claude-structured-journal-prompts'

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
  /** The open turn's provider id — the same id its journal row carries, and the one
   *  a client's Stop names. Sole owner: no reader keeps a copy to disagree with. */
  readonly currentTurnId: string | null
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
  const turn = new ClaudeOpenTurn({
    sink: deps.sink,
    settleChildren: (groupKey) => subagents.settleTurn(groupKey)
  })
  const providerFallback = createClaudeProviderFrameFallback(
    deps.sink,
    deps.fallbackIdPrefix ?? 'acquisition'
  )
  const subagents = new ClaudeSubagentRoster({
    sink: deps.sink,
    currentGroupKey: () => turn.groupKey
  })
  const streamedText = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    persist: (identity, text) => {
      deps.sink.appendItem(identity, claudeStreamingMessageBody(text))
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
    streamedText.append(delta.identity, delta.text)
    return true
  }

  const handleMessage = (
    message: Record<string, unknown>,
    startsTurn: boolean,
    observedAt: number,
    requestedAt?: number
  ): boolean => {
    const envelope = readClaudeMessageEnvelope(message)
    if (!envelope) {
      return false
    }
    let changed = false
    if (envelope.parentToolUseId) {
      subagents.observeChildActivity(envelope.parentToolUseId)
    }
    const outputEnvelope = claudeOutputEnvelope(envelope)
    const body = claudeMessageBody(outputEnvelope)
    // The final frame of a streamed block lands on the block's identity, not its own uuid.
    const identity =
      (body && envelope.role === 'assistant' ? streamedBlocks.reconcile(envelope) : null) ??
      claudeMessageIdentity(envelope)
    streamedText.forget(agentJournalItemKey(identity))
    const thinking = claudeThinkingText(outputEnvelope)
    const source: ClaudeTurnSource = {
      sessionId: envelope.sessionId,
      uuid: envelope.uuid,
      assistant: envelope.role === 'assistant'
    }
    const openOutputTurn = (): void => turn.ensureOpen(message, source, observedAt)
    if (body) {
      // Opening before the append is what brackets a turn around its own first
      // output; a reader that scans back to the turn record and stops would
      // otherwise look straight past the row that opened it.
      turn.ensureOpen(message, source, observedAt)
      deps.sink.appendItem(identity, body)
      changed = true
    }
    for (const tool of claudeToolUses(outputEnvelope)) {
      turn.ensureOpen(message, source, observedAt)
      tools.set(tool.id, tool)
      deps.sink.appendItem(
        claudeToolIdentity(envelope.sessionId, tool.id),
        claudeToolBody({ tool })
      )
      changed = true
    }
    for (const result of claudeToolResults(envelope)) {
      const tool = tools.get(result.toolUseId) ?? {
        id: result.toolUseId,
        name: 'tool',
        input: null
      }
      deps.sink.appendItem(
        claudeToolIdentity(envelope.sessionId, result.toolUseId),
        claudeToolBody({ tool, result })
      )
      // A spawn call's result is the parent turn's evidence its child finished.
      subagents.observeToolResult(result.toolUseId, result.failed)
      // Tool inputs are only needed until their matching result arrives.
      tools.delete(result.toolUseId)
      changed = true
    }
    if (thinking) {
      turn.ensureOpen(message, source, observedAt)
      deps.sink.appendItem(claudeThinkingIdentity(envelope.sessionId, envelope.uuid), {
        kind: 'message',
        role: 'reasoning',
        blocks: [
          { type: 'text', text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
        ]
      })
      changed = true
    }
    changed =
      appendUnmodeledContent(providerFallback, outputEnvelope, message, openOutputTurn) || changed
    // The send's turn is anchored to the user row journaled just above it.
    const sendEchoTurn = claudeTurnOpenedBySendEcho({
      envelope,
      frame: message,
      startsTurn,
      observedAt,
      ...(requestedAt === undefined ? {} : { requestedAt }),
      userItemId: agentJournalItemKey(identity)
    })
    if (sendEchoTurn) {
      turn.allowReopen()
      turn.open(sendEchoTurn, observedAt)
    }
    if (changed) {
      deps.sink.publish()
    }
    return true
  }

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        prompts.retryPendingCancellations()
        streamedText.flush()
        // No event will ever settle a child once the provider is gone.
        subagents.settleSession()
        // The host saw the child end, so the turn's end is observed, not lost.
        turn.settle({ state: 'interrupted', completedAt: event.observedAt ?? Date.now() })
        // A frame that arrives after the child is gone must not open a turn no
        // event can close.
        turn.suppressReopen()
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
          turn.suppressReopenOnFailure(event.message.is_error === true)
          // The turn is over however it ended, so a foreground child still
          // reported as working will never be settled by an event.
          subagents.settleTurn(turn.groupKey)
          turn.settle(claudeTurnEndForResult(event.message, event.observedAt ?? Date.now()))
          // The turn is over. A block still awaiting its final keeps the text the
          // flush above journaled, but its live state goes: an interrupted turn
          // would otherwise retain that text for the life of the session.
          streamedBlocks.clear()
          streamedText.settle()
        }
        const kind = claudeProviderFrameKind(event.message)
        // Ordinary turn bookkeeping stays suppressed; a reported failure never does.
        const failure = claudeResultFailure(event.message)
        if (failure || !isSettledClaudeResultKind(kind)) {
          providerFallback.append(kind, event.message, failure?.text)
        }
      } else if (event.type === 'message') {
        // These frames stay `status-chrome`: the roster reads them here, and the
        // fallback below still drops the raw frame instead of printing an opcode.
        subagents.observeSystemFrame(event.message)
        const kind = claudeProviderFrameKind(event.message)
        if (
          !handleMessage(
            event.message,
            event.startsTurn === true,
            event.observedAt ?? Date.now(),
            event.requestedAt
          )
        ) {
          providerFallback.append(kind, event.message)
        }
        publishActivity(kind, event.message)
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
    get pendingStreamedBlocks() {
      return streamedText.pending
    },
    dispose: () => {
      streamedText.dispose()
      tools.clear()
      prompts.clear()
      streamedBlocks.clear()
      subagents.dispose()
    }
  }
}
