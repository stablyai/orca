// Journaling ONE Claude message envelope: its body, tool calls, tool results,
// reasoning, and the unmodeled content that falls back to a generic row.
//
// Split out of the translator when that file reached its line budget. The body
// moved unchanged; the only edit is that what were closure variables are now
// read off an explicit context, so the open turn and the collaborators it
// writes through stay owned by the translator.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import type { ClaudeForwardedToolRegistry } from './claude-forwarded-tool-registry'
import {
  claudeRecord,
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
import type { ClaudeOpenTurn } from './claude-open-turn'

export type ClaudeMessageJournalContext = {
  sink: StructuredAgentSessionEventSink
  tools: Map<string, ClaudeToolUse>
  streamedBlocks: ReturnType<typeof createClaudeStreamedBlockRegistry>
  streamedText: ReturnType<typeof createClaudeStreamedTextCheckpoints>
  subagents: ClaudeSubagentRoster
  forwardedTools: ClaudeForwardedToolRegistry
  backgroundTasks: ClaudeBackgroundTaskRows
  providerFallback: ClaudeProviderFrameFallback
  /** The session's open turn. Sole owner of turn identity and of the reopen
   *  latch; this module asks it rather than tracking a copy. */
  turn: ClaudeOpenTurn
}

export function journalClaudeMessage(
  ctx: ClaudeMessageJournalContext,
  message: Record<string, unknown>,
  startsTurn: boolean,
  observedAt: number,
  /** Host clock on the submission that produced this send, when known. */
  requestedAt?: number
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
  const openOutputTurn = (): void => ctx.turn.ensureOpen(message, source, observedAt)
  if (body) {
    // Opening before the append is what brackets a turn around its own first
    // output; a reader that scans back to the turn record and stops would
    // otherwise look straight past the row that opened it.
    ctx.turn.ensureOpen(message, source, observedAt)
    ctx.sink.appendItem(identity, body)
    changed = true
  }
  for (const tool of claudeToolUses(outputEnvelope)) {
    ctx.turn.ensureOpen(message, source, observedAt)
    ctx.tools.set(tool.id, tool)
    // Only a TOP-LEVEL call can be the parent of a top-level task row; a
    // sidechain's own tool ids never reach the transcript.
    if (!envelope.parentToolUseId) {
      ctx.forwardedTools.record(tool.id)
    }
    ctx.sink.appendItem(claudeToolIdentity(envelope.sessionId, tool.id), claudeToolBody({ tool }))
    changed = true
  }
  const results = claudeToolResults(envelope)
  for (const result of results) {
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
    if (
      results.length === 1 &&
      envelope.parentToolUseId === null &&
      tool.name === 'Monitor' &&
      ctx.forwardedTools.has(result.toolUseId)
    ) {
      ctx.backgroundTasks.observeMonitorToolResult(claudeRecord(message.tool_use_result)?.taskId)
    }
    ctx.tools.delete(result.toolUseId)
    changed = true
  }
  if (thinking) {
    ctx.turn.ensureOpen(message, source, observedAt)
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
    ...(requestedAt === undefined ? {} : { requestedAt }),
    userItemId: agentJournalItemKey(identity)
  })
  if (sendEchoTurn) {
    ctx.turn.allowReopen()
    ctx.turn.open(sendEchoTurn, observedAt)
  }
  if (changed) {
    ctx.sink.publish()
  }
  return true
}
