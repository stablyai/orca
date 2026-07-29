import type { AgentType, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat-agent-support'
import { isNoiseMessage } from '../../shared/native-chat-noise'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { decodeClaudeTranscriptLine } from './transcript-line-decoders-claude'
import {
  claudeInterruptedMessageId,
  CODEX_EVENT_TURN_ABORTED,
  CODEX_EVENT_TURN_COMPLETE,
  CODEX_EVENT_TURN_STARTED
} from './transcript-turn-markers'

export type NativeChatTurnLifecycleDecoder = (
  line: string,
  fallbackId: string
) => NativeChatTurnLifecycle | null

export function nativeChatTurnLifecycleDecoderForAgent(
  agent: AgentType
): NativeChatTurnLifecycleDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'codex') {
    return decodeCodexTurnLifecycle
  }
  if (transcriptAgent === 'claude') {
    return decodeClaudeTurnLifecycle
  }
  return null
}

export function decodeCodexTurnLifecycle(
  line: string,
  fallbackId: string
): NativeChatTurnLifecycle | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (record?.type !== 'event_msg' || !payload) {
    return null
  }
  if (
    payload.type !== CODEX_EVENT_TURN_STARTED &&
    payload.type !== CODEX_EVENT_TURN_COMPLETE &&
    payload.type !== CODEX_EVENT_TURN_ABORTED
  ) {
    return null
  }
  const state =
    payload.type === CODEX_EVENT_TURN_STARTED
      ? 'working'
      : payload.type === CODEX_EVENT_TURN_ABORTED
        ? 'interrupted'
        : 'completed'
  return {
    state,
    turnId: extractString(payload.turn_id) ?? fallbackId,
    timestamp: lifecycleTimestamp(record.timestamp)
  }
}

/** Claude stop reasons that end the lead generation (not mid-turn tool_use). */
const CLAUDE_TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal'])

function isClaudeTerminalStopReason(value: unknown): boolean {
  return typeof value === 'string' && CLAUDE_TERMINAL_STOP_REASONS.has(value)
}

export function decodeClaudeTurnLifecycle(
  line: string,
  fallbackId: string
): NativeChatTurnLifecycle | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const message = asRecord(record.message)
  const timestamp = lifecycleTimestamp(record.timestamp)
  const interruptedMessageId = claudeInterruptedMessageId(record)
  if (interruptedMessageId) {
    // Why: Claude stores its interrupt notice as an injected user row; it ends
    // the active generation and must not be mistaken for the next user prompt.
    return { state: 'interrupted', turnId: interruptedMessageId, timestamp }
  }
  if (record.type === 'assistant') {
    const stopReason = message?.stop_reason
    // Why: capable hosts rely on explicit terminals (prose is only a backup when
    // the latest lifecycle is not mid-generation). Emit completed for every real
    // end marker — including historical/OpenClaude rows that omit stop_reason —
    // while tool_use stays non-terminal so mid-turn tool loops keep working. The
    // no-stop_reason backup also excludes rows carrying a tool_use block: a
    // pre-tool assistant row that omits stop_reason is mid-turn, not done, so it
    // must not settle the spinner before the tool runs.
    const isTerminal =
      isClaudeTerminalStopReason(stopReason) ||
      (stopReason == null &&
        assistantHasRenderableContent(message) &&
        !assistantHasToolUse(message))
    if (isTerminal) {
      return {
        state: 'completed',
        turnId: extractString(record.uuid) ?? extractString(message?.id) ?? fallbackId,
        timestamp
      }
    }
    return null
  }
  if (record.type !== 'user') {
    return null
  }
  const decoded = decodeClaudeTranscriptLine(line, fallbackId)
  if (decoded?.role !== 'user' || decoded.blocks.some((block) => block.type === 'tool-result')) {
    // Why: Claude can attach text sidecars to tool-result user rows; those are
    // continuations of the active turn, not a new user-authored generation.
    return null
  }
  // Why: harness noise (task-notification, system-reminder, …) is user-role in
  // the JSONL but not a new generation. Treating it as working would overwrite
  // a real terminal marker and re-stick the chat spinner after done/interrupt.
  if (isNoiseMessage(decoded)) {
    return null
  }
  return { state: 'working', turnId: decoded.id, timestamp }
}

function lifecycleTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}

function assistantHasRenderableContent(message: Record<string, unknown> | null): boolean {
  const content = message?.content
  if (typeof content === 'string') {
    return content.trim().length > 0
  }
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => {
    const record = asRecord(block)
    if (!record) {
      return false
    }
    if (
      record.type === 'text' &&
      typeof record.text === 'string' &&
      record.text.trim().length > 0
    ) {
      return true
    }
    if (record.type === 'thinking' || record.type === 'redacted_thinking') {
      return true
    }
    return false
  })
}

/** True when an assistant row contains a tool_use block — the turn continues to
 *  a tool call, so a missing stop_reason must not be read as completion. */
function assistantHasToolUse(message: Record<string, unknown> | null): boolean {
  const content = message?.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => asRecord(block)?.type === 'tool_use')
}
