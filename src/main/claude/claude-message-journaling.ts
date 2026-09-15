// Journaling ONE Claude message envelope: its body, tool calls, tool results,
// reasoning, and the unmodeled content that falls back to a generic row.
//
// Split out of the translator when that file reached its line budget. The body
// moved unchanged; the only edit is that what were closure variables are now
// read off an explicit context, so the turn opener and the collaborators it
// writes through stay owned by the translator.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeForwardedToolRegistry } from './claude-forwarded-tool-registry'
import {
  claudeMessageBody,
  claudeMessageIdentity,
  claudeOutputEnvelope,
  claudeThinkingIdentity,
  claudeThinkingText,
  claudeToolBody,
  claudeToolIdentity,
  claudeToolResults,
  claudeToolUses,
  readClaudeMessageEnvelope,
  type ClaudeToolUse
} from './claude-structured-item-translation'
import {
  appendUnmodeledContent,
  type ClaudeProviderFrameFallback
} from './claude-structured-provider-fallback'
import type { createClaudeStreamedBlockRegistry } from './claude-streamed-block-identity'
import type { createClaudeStreamedTextCheckpoints } from './claude-streamed-text-checkpoints'
import type { ClaudeSubagentRoster } from './claude-subagent-roster'
import { claudeTurnOpenedBySendEcho, type ClaudeTurnSource } from './claude-turn-opening'
import type { ClaudeCurrentTurn } from './claude-turn-lifecycle-item'

export type ClaudeMessageJournalContext = {
  sink: StructuredAgentSessionEventSink
  tools: Map<string, ClaudeToolUse>
  streamedBlocks: ReturnType<typeof createClaudeStreamedBlockRegistry>
  streamedText: ReturnType<typeof createClaudeStreamedTextCheckpoints>
  subagents: ClaudeSubagentRoster
  forwardedTools: ClaudeForwardedToolRegistry
  providerFallback: ClaudeProviderFrameFallback
  ensureTurnOpen: (
    frame: Record<string, unknown>,
    source: ClaudeTurnSource | null,
    observedAt: number
  ) => void
  openTurn: (turn: ClaudeCurrentTurn, observedAt: number) => void
  /** An accepted send is the only thing that lifts the reopen latch. */
  liftSuppression: () => void
}

export function journalClaudeMessage(
  ctx: ClaudeMessageJournalContext,
  message: Record<string, unknown>,
  startsTurn: boolean,
  observedAt: number
): boolean {
  const envelope = readClaudeMessageEnvelope(message)
  if (!envelope) {
    return false
  }
  let changed = false
  if (envelope.parentToolUseId) {
    ctx.subagents.observeChildActivity(envelope.parentToolUseId)
  }
  const outputEnvelope = claudeOutputEnvelope(envelope)
  const body = claudeMessageBody(outputEnvelope)
  const identity =
    (body && envelope.role === 'assistant' ? ctx.streamedBlocks.reconcile(envelope) : null) ??
    claudeMessageIdentity(envelope)
  ctx.streamedText.forget(agentJournalItemKey(identity))
  const thinking = claudeThinkingText(outputEnvelope)
  const source: ClaudeTurnSource = {
    sessionId: envelope.sessionId,
    uuid: envelope.uuid,
    assistant: envelope.role === 'assistant'
  }
  const openOutputTurn = (): void => ctx.ensureTurnOpen(message, source, observedAt)
  if (body) {
    // Opening before the append is what brackets a turn around its own first
    // output; a reader that scans back to the turn record and stops would
    // otherwise look straight past the row that opened it.
    ctx.ensureTurnOpen(message, source, observedAt)
    ctx.sink.appendItem(identity, body)
    changed = true
  }
  for (const tool of claudeToolUses(outputEnvelope)) {
    ctx.ensureTurnOpen(message, source, observedAt)
    ctx.tools.set(tool.id, tool)
    // Only a TOP-LEVEL call can be the parent of a top-level task row; a
    // sidechain's own tool ids never reach the transcript.
    if (!envelope.parentToolUseId) {
      ctx.forwardedTools.record(tool.id)
    }
    ctx.sink.appendItem(claudeToolIdentity(envelope.sessionId, tool.id), claudeToolBody({ tool }))
    changed = true
  }
  for (const result of claudeToolResults(envelope)) {
    const tool = ctx.tools.get(result.toolUseId) ?? {
      id: result.toolUseId,
      name: 'tool',
      input: null
    }
    ctx.sink.appendItem(
      claudeToolIdentity(envelope.sessionId, result.toolUseId),
      claudeToolBody({ tool, result })
    )
    ctx.subagents.observeToolResult(result.toolUseId, result.failed)
    ctx.tools.delete(result.toolUseId)
    changed = true
  }
  if (thinking) {
    ctx.ensureTurnOpen(message, source, observedAt)
    ctx.sink.appendItem(claudeThinkingIdentity(envelope.sessionId, envelope.uuid), {
      kind: 'message',
      role: 'reasoning',
      blocks: [
        { type: 'text', text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
      ]
    })
    changed = true
  }
  changed =
    appendUnmodeledContent(ctx.providerFallback, outputEnvelope, message, openOutputTurn) || changed
  // The send's turn is anchored to the user row journaled just above it.
  const sendEchoTurn = claudeTurnOpenedBySendEcho({
    envelope,
    frame: message,
    startsTurn,
    observedAt,
    userItemId: agentJournalItemKey(identity)
  })
  if (sendEchoTurn) {
    ctx.liftSuppression()
    ctx.openTurn(sendEchoTurn, observedAt)
  }
  if (changed) {
    ctx.sink.publish()
  }
  return true
}
