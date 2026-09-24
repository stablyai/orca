// Journaling ONE Claude message envelope: its body, tool calls, tool results,
// reasoning, and the unmodeled content that falls back to a generic row.
//
// Split out of the translator when that file reached its line budget. The body
// moved unchanged; the only edit is that what were closure variables are now
// read off an explicit context, so the open turn and the collaborators it
// writes through stay owned by the translator.

import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import {
  boundInlineText,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import type { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'
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
import type { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import type { ClaudeSubagentRoster } from './claude-subagent-roster'
import { claudeTurnOpenedBySendEcho, type ClaudeTurnSource } from './claude-turn-opening'
import type { ClaudeOpenTurn } from './claude-open-turn'

export type ClaudeMessageJournalContext = {
  sink: StructuredAgentSessionEventSink
  tools: Map<string, ClaudeToolUse>
  streamedBlocks: ReturnType<typeof createClaudeStreamedBlockRegistry>
  streamedText: ReturnType<typeof createClaudeStreamedTextCheckpoints>
  subagents: ClaudeSubagentRoster
  toolOrigins: ClaudeToolOriginRegistry
  backgroundTasks: ClaudeBackgroundTaskRows
  providerFallback: ClaudeProviderFrameFallback
  /** Attributes every row this module writes to the agent that produced it, and
   *  remembers the ones stamped before that agent had a final identity. */
  corrections: ClaudeProvisionalRowCorrections
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
  const results = claudeToolResults(envelope)
  // Everything this envelope journals belongs to whoever produced the envelope.
  // A child's rows live in the parent's journal, so without this the parent's
  // own "what am I doing" readers report the child's newest output as their own.
  //
  // Delivering the result of the very call it names as parent is the exception:
  // that is the CALLER consuming its own tool output, not a child's row. Only a
  // spawn call ever gets a sidechain, so reading the field literally here would
  // park every ordinary tool result against an announcement never coming.
  //
  // The caller is not always the session's own agent. A call a child made is
  // owned by that child, and its result is the child's row too — collapsing it
  // to root would both misattribute it and make the result's write resolve
  // through a different reference than the call's, stranding the correction
  // owed to that row on the body it had before the result landed.
  const producedByCaller = results.some((result) => result.toolUseId === envelope.parentToolUseId)
  const producerRef =
    producedByCaller && envelope.parentToolUseId !== null
      ? ctx.toolOrigins.childOwnerRef(envelope.parentToolUseId)
      : envelope.parentToolUseId
  const stamp = ctx.corrections.stampFor(producerRef)
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
    ctx.sink.appendItem(identity, body, stamp(identity, body))
    changed = true
  }
  for (const tool of claudeToolUses(outputEnvelope)) {
    ctx.turn.ensureOpen(message, source, observedAt)
    ctx.tools.set(tool.id, tool)
    // Only a TOP-LEVEL call can be the parent of a top-level task row; a
    // sidechain's own tool ids never reach the transcript. Those are recorded
    // against their owner instead: a grandchild's frames name one of them and
    // nothing else, so this is the only place its parent is ever knowable.
    if (envelope.parentToolUseId) {
      ctx.toolOrigins.recordChildOwned(tool.id, envelope.parentToolUseId)
    } else {
      ctx.toolOrigins.recordTopLevel(tool.id)
    }
    const toolIdentity = claudeToolIdentity(envelope.sessionId, tool.id)
    const toolBody = claudeToolBody({ tool })
    ctx.sink.appendItem(toolIdentity, toolBody, stamp(toolIdentity, toolBody))
    changed = true
  }
  for (const result of results) {
    const tool = ctx.tools.get(result.toolUseId) ?? {
      id: result.toolUseId,
      name: 'tool',
      input: null
    }
    const resultIdentity = claudeToolIdentity(envelope.sessionId, result.toolUseId)
    const resultBody = claudeToolBody({ tool, result })
    ctx.sink.appendItem(resultIdentity, resultBody, stamp(resultIdentity, resultBody))
    ctx.subagents.observeToolResult(result.toolUseId, result.failed)
    if (
      results.length === 1 &&
      envelope.parentToolUseId === null &&
      tool.name === 'Monitor' &&
      ctx.toolOrigins.has(result.toolUseId)
    ) {
      ctx.backgroundTasks.observeMonitorToolResult(claudeRecord(message.tool_use_result)?.taskId)
    }
    ctx.tools.delete(result.toolUseId)
    changed = true
  }
  if (thinking) {
    ctx.turn.ensureOpen(message, source, observedAt)
    const thinkingIdentity = claudeThinkingIdentity(envelope.sessionId, envelope.uuid)
    const thinkingBody: AgentJournalItemBody = {
      kind: 'message',
      role: 'reasoning',
      blocks: [
        { type: 'text', text: boundInlineText(thinking, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }
      ]
    }
    ctx.sink.appendItem(thinkingIdentity, thinkingBody, stamp(thinkingIdentity, thinkingBody))
    changed = true
  }
  changed =
    appendUnmodeledContent(ctx.providerFallback, outputEnvelope, message, openOutputTurn, stamp) ||
    changed
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
