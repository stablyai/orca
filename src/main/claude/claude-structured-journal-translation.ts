import type {
  AgentJournalItemIdentity,
  AgentJournalTurn
} from '../../shared/agent-session-journal-types'
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
  claudeLifecycleIdentity,
  claudeLifecycleBody,
  claudeMessageIdentity,
  claudeHasReplayContent,
  claudeRecord,
  claudeStreamingMessageBody,
  claudeText,
  claudeThinkingIdentity,
  claudeThinkingText,
  claudeToolBody,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import { publishClaudePrompt } from './claude-structured-prompt-items'
import { readableProviderFrameText } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import {
  CLAUDE_UNRENDERABLE_CONTENT_TEXT,
  claudeProviderFrameKind,
  claudeResultFailure,
  createClaudeProviderFrameFallback,
  isModeledClaudeContent,
  isSettledClaudeResultKind
} from './claude-structured-provider-fallback'
import { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'

export type ClaudeJournalTranslatorDeps = {
  sink: StructuredAgentSessionEventSink
  bindPromptItemId?: (journalItemId: string, promptKey: string, questionId?: string) => void
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
  fallbackIdPrefix?: string
}

export type ClaudeJournalTranslator = {
  handle: (event: ClaudeStructuredSessionEvent) => void
  flush: () => void
  /** Streamed blocks still awaiting a final frame. A settled turn leaves none. */
  readonly currentTurnId: string | null
  readonly pendingStreamedBlocks: number
  dispose: () => void
}

export function createClaudeJournalTranslator(
  deps: ClaudeJournalTranslatorDeps
): ClaudeJournalTranslator {
  const tools = new Map<string, ClaudeToolUse>()
  const promptItems = new Map<string, AgentJournalItemIdentity[]>()
  const streamedBlocks = createClaudeStreamedBlockRegistry()
  let currentTurn: { sessionId: string; turnId: string } | null = null
  let lastAssistant: AgentJournalItemIdentity | null = null
  const sink: StructuredAgentSessionEventSink = {
    ...deps.sink,
    appendItem: (identity, body, options) =>
      deps.sink.appendItem(
        currentTurn && !identity.turn && !(body.kind === 'message' && body.role === 'user')
          ? { ...identity, turn: { turnId: currentTurn.turnId } }
          : identity,
        body,
        options
      )
  }
  const providerFallback = createClaudeProviderFrameFallback(
    sink,
    deps.fallbackIdPrefix ?? 'acquisition'
  )
  const streamedText = createClaudeStreamedTextCheckpoints({
    ...(deps.coalesceMs === undefined ? {} : { coalesceMs: deps.coalesceMs }),
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    persist: (identity, text) => {
      const reasoning =
        identity.provider === 'orca' && identity.clientMessageId.startsWith('claude-thinking:')
      const body = reasoning
        ? {
            kind: 'message' as const,
            role: 'reasoning' as const,
            blocks: [{ type: 'text' as const, text }]
          }
        : { ...claudeStreamingMessageBody(text), assistantPhase: 'commentary' as const }
      sink.appendItem(identity, body)
      sink.publish()
    }
  })

  const publishLifecycle = (
    sessionId: string,
    turnId: string,
    running: boolean,
    outcome: 'completed' | 'interrupted' | 'failed' = 'completed'
  ): void => {
    const identity = claudeLifecycleIdentity(sessionId, turnId)
    sink.appendItem(identity, claudeLifecycleBody(turnId, running, outcome))
    sink.publish()
  }

  const handleStream = (message: Record<string, unknown>): boolean => {
    const delta = streamedBlocks.observe(message)
    if (!delta) {
      return false
    }
    if (delta.role === 'assistant' && message.parent_tool_use_id === null) {
      lastAssistant = delta.identity
    }
    streamedText.append(delta.identity, delta.text)
    return true
  }

  const handleMessage = (
    message: Record<string, unknown>,
    startsTurn: boolean,
    turn?: AgentJournalTurn
  ): boolean => {
    const envelope = readClaudeMessageEnvelope(message)
    if (!envelope) {
      return false
    }
    if (
      envelope.role === 'user' &&
      startsTurn &&
      claudeHasReplayContent(envelope) &&
      message.parent_tool_use_id === null
    ) {
      if (currentTurn) {
        publishLifecycle(currentTurn.sessionId, currentTurn.turnId, false)
      }
      lastAssistant = null
      currentTurn = { sessionId: envelope.sessionId, turnId: envelope.uuid }
      publishLifecycle(envelope.sessionId, envelope.uuid, true)
    }
    let changed = false
    const body = claudeMessageBody(envelope)
    // The final frame of a streamed block lands on the block's identity, not its own uuid.
    const identity =
      (body && envelope.role === 'assistant' ? streamedBlocks.reconcile(envelope) : null) ??
      claudeMessageIdentity(envelope)
    streamedText.forget(agentJournalItemKey(identity))
    if (body) {
      const ownedIdentity = turn
        ? { ...identity, turn }
        : startsTurn
          ? { ...identity, turn: { turnId: envelope.uuid, root: true as const } }
          : identity
      if (envelope.role === 'assistant' && envelope.parentToolUseId === null) {
        body.assistantPhase = 'commentary'
        lastAssistant = ownedIdentity
      }
      sink.appendItem(ownedIdentity, body)
      changed = true
    }
    for (const tool of claudeToolUses(envelope)) {
      tools.set(tool.id, tool)
      sink.appendItem(claudeToolIdentity(envelope.sessionId, tool.id), claudeToolBody({ tool }))
      changed = true
    }
    for (const result of claudeToolResults(envelope)) {
      const tool = tools.get(result.toolUseId) ?? {
        id: result.toolUseId,
        name: 'tool',
        input: null
      }
      sink.appendItem(
        claudeToolIdentity(envelope.sessionId, result.toolUseId),
        claudeToolBody({ tool, result })
      )
      // Tool inputs are only needed until their matching result arrives.
      tools.delete(result.toolUseId)
      changed = true
    }
    if (claudeToolUses(envelope).length > 0 && envelope.parentToolUseId === null) {
      lastAssistant = null
    }
    const thinking = claudeThinkingText(envelope)
    if (thinking) {
      const thinkingIdentity =
        streamedBlocks.reconcile(envelope, 'reasoning') ??
        claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
      streamedText.forget(agentJournalItemKey(thinkingIdentity))
      sink.appendItem(thinkingIdentity, {
        kind: 'message',
        role: 'reasoning',
        blocks: [
          { type: 'text', text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
        ]
      })
      changed = true
    }
    const unhandledContent = envelope.content.filter((part) => !isModeledClaudeContent(part))
    for (const part of unhandledContent) {
      const partType = claudeText(claudeRecord(part)?.type) ?? 'unknown'
      providerFallback.append(
        `message:${envelope.role}:content:${partType}`,
        part,
        readableProviderFrameText(part) ?? CLAUDE_UNRENDERABLE_CONTENT_TEXT
      )
      changed = true
    }
    // An empty user frame is a replay with nothing to show, not an unknown kind.
    if (envelope.content.length === 0 && envelope.role === 'assistant') {
      providerFallback.append(`message:${envelope.role}:empty`, message)
      changed = true
    }
    if (changed) {
      sink.publish()
    }
    return true
  }

  return {
    handle: (event) => {
      if (event.type === 'ended') {
        streamedText.flush()
        if (currentTurn) {
          publishLifecycle(
            currentTurn.sessionId,
            currentTurn.turnId,
            false,
            event.cause === 'unexpected-exit' ? 'failed' : 'interrupted'
          )
          currentTurn = null
        }
        return
      }
      if (event.type === 'message' && handleStream(event.message)) {
        return
      }
      streamedText.flush()
      if (event.type === 'prompt') {
        promptItems.set(
          event.prompt.promptKey,
          publishClaudePrompt(sink, event, deps.bindPromptItemId)
        )
      } else if (event.type === 'prompt-cancelled') {
        for (const identity of promptItems.get(event.promptKey) ?? []) {
          sink.appendTombstone(identity)
        }
        promptItems.delete(event.promptKey)
        sink.publish()
      } else if (event.type === 'message' && event.message.type === 'result') {
        const failure = claudeResultFailure(event.message)
        const interrupted =
          event.message.terminal_reason === 'aborted_streaming' ||
          event.message.terminal_reason === 'aborted_tools'
        const outcome = interrupted ? 'interrupted' : failure ? 'failed' : 'completed'
        const finalText = outcome === 'completed' ? claudeText(event.message.result) : null
        if (finalText && currentTurn) {
          const identity =
            lastAssistant ??
            claudeMessageIdentity({
              sessionId: currentTurn.sessionId,
              uuid: claudeText(event.message.uuid) ?? `${currentTurn.turnId}:final`
            })
          sink.appendItem(identity, {
            kind: 'message',
            role: 'assistant',
            assistantPhase: 'final',
            blocks: [{ type: 'text', text: finalText }]
          })
        }
        // The turn is over. A block still awaiting its final keeps the text the
        // flush above journaled, but its live state goes: an interrupted turn
        // would otherwise retain that text for the life of the session.
        streamedBlocks.clear()
        streamedText.settle()
        const kind = claudeProviderFrameKind(event.message)
        // Ordinary turn bookkeeping stays suppressed; a reported failure never does.
        if (failure || !isSettledClaudeResultKind(kind)) {
          providerFallback.append(kind, event.message, failure?.text)
        }
        if (currentTurn) {
          publishLifecycle(currentTurn.sessionId, currentTurn.turnId, false, outcome)
          currentTurn = null
        }
        lastAssistant = null
      } else if (event.type === 'message') {
        if (!handleMessage(event.message, event.startsTurn === true, event.turn)) {
          providerFallback.append(claudeProviderFrameKind(event.message), event.message)
        }
      } else if (event.type === 'provider-frame') {
        providerFallback.append(event.kind, event.payload)
      }
    },
    flush: streamedText.flush,
    get currentTurnId() {
      return currentTurn?.turnId ?? null
    },
    get pendingStreamedBlocks() {
      return streamedText.pending
    },
    dispose: () => {
      streamedText.dispose()
      tools.clear()
      promptItems.clear()
      streamedBlocks.clear()
    }
  }
}
