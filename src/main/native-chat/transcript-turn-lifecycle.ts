import type { AgentType, NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { resolveNativeChatTranscriptAgent } from '../../shared/native-chat/native-chat-agent-support'
import { isNoiseMessage } from '../../shared/native-chat/native-chat-noise'
import { claudeBashInputAsTypedCommand } from '../../shared/claude-bash-input'
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
  agent: AgentType,
  explicitOnly = false
): NativeChatTurnLifecycleDecoder | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  if (transcriptAgent === 'codex') {
    return decodeCodexTurnLifecycle
  }
  if (transcriptAgent === 'claude') {
    return (line, fallbackId) => decodeClaudeTurnLifecycle(line, fallbackId, explicitOnly)
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
    // Only a user's interrupt is a Stop; replaced, review-ended and budget-limited aborts aren't.
    ...(state === 'interrupted' && payload.reason === 'interrupted'
      ? { outcome: 'cancellation' as const }
      : {}),
    turnId: extractString(payload.turn_id) ?? fallbackId,
    timestamp: lifecycleTimestamp(record.timestamp)
  }
}

const CLAUDE_TERMINAL_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'refusal'])

function isClaudeTerminalStopReason(value: unknown): boolean {
  return typeof value === 'string' && CLAUDE_TERMINAL_STOP_REASONS.has(value)
}

export function decodeClaudeTurnLifecycle(
  line: string,
  fallbackId: string,
  explicitOnly = false
): NativeChatTurnLifecycle | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  const message = asRecord(record.message)
  const timestamp = lifecycleTimestamp(record.timestamp)
  const interruptedMessageId = claudeInterruptedMessageId(record)
  if (interruptedMessageId || (record.type === 'user' && isClaudeInterruptionNotice(message))) {
    // Injected interruption notices end the active generation as the user's Stop; they never open
    // a user turn. Esc before any reply writes the notice without the interrupted message's id.
    return {
      state: 'interrupted',
      outcome: 'cancellation',
      turnId: interruptedMessageId ?? extractString(record.uuid) ?? fallbackId,
      timestamp
    }
  }
  if (record.type === 'assistant') {
    const stopReason = message?.stop_reason
    // Legacy rows may omit stop_reason; only complete prose without tool_use can supply that fallback.
    const isTerminal =
      isClaudeTerminalStopReason(stopReason) ||
      (!explicitOnly &&
        stopReason == null &&
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
    // Tool-result sidecar text continues the turn instead of opening a user generation.
    return null
  }
  // Injected noise must not overwrite terminal markers and restart the spinner.
  if (isNoiseMessage(decoded) || isClaudeBashInputRecord(record)) {
    return null
  }
  return { state: 'working', turnId: decoded.id, timestamp }
}

const CLAUDE_INTERRUPTION_NOTICE = /^\[Request interrupted by user( for tool use)?\]$/

function isClaudeInterruptionNotice(message: Record<string, unknown> | null): boolean {
  const content = message?.content
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content) && content.length === 1
        ? extractString(asRecord(content[0])?.text)
        : null
  return message?.role === 'user' && text != null && CLAUDE_INTERRUPTION_NOTICE.test(text)
}

// ! commands are not prompts; without a reply terminal, a working mark would stick.
function isClaudeBashInputRecord(record: Record<string, unknown>): boolean {
  const content = asRecord(record.message)?.content
  const texts =
    typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.map((block) => extractString(asRecord(block)?.text))
        : []
  return texts.some((text) => text != null && claudeBashInputAsTypedCommand(text) !== null)
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

function assistantHasToolUse(message: Record<string, unknown> | null): boolean {
  const content = message?.content
  if (!Array.isArray(content)) {
    return false
  }
  return content.some((block) => asRecord(block)?.type === 'tool_use')
}

/** Pi persists explicit assistant stop reasons on the selected session branch. */
export function decodePiTurnLifecycle(
  line: string,
  fallbackId: string
): NativeChatTurnLifecycle | null {
  const record = parseJsonObject(line)
  const message = asRecord(record?.message)
  if (record?.type !== 'message' || !message) {
    return null
  }
  const turnId = extractString(record.id) ?? fallbackId
  const timestamp = lifecycleTimestamp(record.timestamp)
  if (message.role === 'user') {
    return { state: 'working', turnId, timestamp }
  }
  if (message.role !== 'assistant') {
    return null
  }
  const state =
    message.stopReason === 'aborted'
      ? 'interrupted'
      : message.stopReason === 'error'
        ? 'failed'
        : message.stopReason === 'stop' || message.stopReason === 'length'
          ? 'completed'
          : null
  return state
    ? {
        state: state === 'failed' ? 'completed' : state,
        ...(state === 'failed'
          ? { outcome: 'failure' as const }
          : state === 'interrupted'
            ? { outcome: 'cancellation' as const }
            : {}),
        turnId,
        timestamp
      }
    : null
}
