import { writeClaudeTerminalFailure } from './claude-terminal-failure'
import { agentSessionFailureWords } from '../../shared/agent-session-failure-words'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRows } from './claude-background-task-rows'
import type { ClaudeToolOriginRegistry } from './claude-tool-origin-registry'
import {
  claudeRecord,
  claudeMessageBody,
  claudeMessageIdentity,
  claudeOutputEnvelope,
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
import type { ClaudeStreamedThinking } from './claude-streamed-thinking'
import type { ClaudeProvisionalRowCorrections } from './claude-provisional-row-corrections'
import type { ClaudeSubagentIdentities } from './claude-subagent-identities'
import { claudeTurnOpenedBySendEcho, type ClaudeTurnSource } from './claude-turn-opening'
import type { ClaudeOpenTurn } from './claude-open-turn'
import type { ClaudeAssistantFailures } from './claude-assistant-failures'
import type { ClaudeUsageLimits } from './claude-usage-limits'
import type { ClaudeThreadGoal } from './claude-thread-goal'

export type ClaudeMessageJournalContext = {
  sink: StructuredAgentSessionEventSink
  tools: Map<string, ClaudeToolUse>
  streamedBlocks: ReturnType<typeof createClaudeStreamedBlockRegistry>
  streamedText: ReturnType<typeof createClaudeStreamedTextCheckpoints>
  streamedThinking: ClaudeStreamedThinking
  subagents: ClaudeSubagentIdentities
  toolOrigins: ClaudeToolOriginRegistry
  backgroundTasks: ClaudeBackgroundTaskRows
  providerFallback: ClaudeProviderFrameFallback
  /** Stamp producer identity and retain rows needing later identity corrections. */
  corrections: ClaudeProvisionalRowCorrections
  turn: ClaudeOpenTurn
  assistantFailures: ClaudeAssistantFailures
  usageLimits: ClaudeUsageLimits
  threadGoal: ClaudeThreadGoal
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
  const results = claudeToolResults(envelope)
  // Tool results belong to their caller, including child callers; preserve its reference for later corrections.
  // Other rows belong to the envelope producer so child output cannot become root activity.
  const producedByCaller = results.some((result) => result.toolUseId === envelope.parentToolUseId)
  const producerRef =
    producedByCaller && envelope.parentToolUseId !== null
      ? ctx.toolOrigins.childOwnerRef(envelope.parentToolUseId)
      : envelope.parentToolUseId
  const stamp = ctx.corrections.stampFor(producerRef)
  const outputEnvelope = claudeOutputEnvelope(envelope)
  ctx.threadGoal.observe(message)
  const source: ClaudeTurnSource = {
    sessionId: envelope.sessionId,
    uuid: envelope.uuid,
    assistant: envelope.role === 'assistant'
  }
  const openOutputTurn = (): void => ctx.turn.ensureOpen(message, source, observedAt)
  const messageBody = claudeMessageBody(outputEnvelope)
  const ordinaryFailure =
    typeof message.api_error === 'string' && message.api_error !== 'usage_limit_reached'
      ? {
          kind: 'status' as const,
          tone: 'error' as const,
          ...agentSessionFailureWords(
            { kind: 'providerRejected' },
            { agentName: 'Claude', provider: 'claude', surface: 'row' }
          )
        }
      : null
  const terminal =
    envelope.role === 'assistant' &&
    producerRef === null &&
    (typeof message.api_error === 'string' || message.error === 'rate_limit')
  if (
    envelope.role === 'assistant' &&
    (messageBody || typeof message.api_error === 'string' || message.error === 'rate_limit')
  ) {
    openOutputTurn()
  }
  const usageLimit = ctx.usageLimits.assistant(message, ctx.turn)
  const body =
    ctx.assistantFailures.assistant(message) ??
    usageLimit ??
    ctx.threadGoal.report(message, claudeMessageIdentity(envelope), observedAt) ??
    messageBody ??
    ordinaryFailure
  const terminalIdentity = terminal && ctx.turn.identity && usageLimit ? ctx.turn.identity : null
  const identity =
    (body && envelope.role === 'assistant'
      ? ctx.streamedBlocks.reconcile(envelope)?.identity
      : null) ?? claudeMessageIdentity(envelope)
  ctx.streamedText.forget(agentJournalItemKey(identity))
  const thinking = ctx.streamedThinking.finalize(outputEnvelope, observedAt)
  if (body) {
    // Open before appending so backward scans include the turn's first output.
    ctx.turn.ensureOpen(message, source, observedAt)
    if (terminalIdentity) {
      writeClaudeTerminalFailure(ctx.sink, terminalIdentity, body)
    } else {
      ctx.sink.appendItem(identity, body, { ...stamp(identity, body), lifecycle: true })
    }
    changed = true
  }
  for (const tool of claudeToolUses(outputEnvelope)) {
    ctx.turn.ensureOpen(message, source, observedAt)
    ctx.tools.set(tool.id, tool)
    // Record child-owned calls here: grandchild frames name their tool IDs, absent from the root transcript.
    if (envelope.parentToolUseId) {
      ctx.toolOrigins.recordChildOwned(tool.id, envelope.parentToolUseId)
    } else {
      ctx.toolOrigins.recordTopLevel(tool.id)
    }
    const toolIdentity = claudeToolIdentity(envelope.sessionId, tool.id)
    const toolBody = claudeToolBody({ tool })
    ctx.sink.appendItem(toolIdentity, toolBody, {
      ...stamp(toolIdentity, toolBody),
      lifecycle: true
    })
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
    ctx.sink.appendItem(resultIdentity, resultBody, {
      ...stamp(resultIdentity, resultBody),
      lifecycle: true
    })
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
    // Preserve this terminal write under pressure so the thinking row cannot stay open.
    ctx.sink.appendItem(thinking.identity, thinking.body, {
      ...stamp(thinking.identity, thinking.body),
      ...(thinking.startedAt === undefined ? {} : { observedAt: thinking.startedAt }),
      lifecycle: true
    })
    changed = true
  }
  changed =
    appendUnmodeledContent(ctx.providerFallback, outputEnvelope, message, openOutputTurn, stamp) ||
    changed
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
