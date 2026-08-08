import type { NativeChatMessage } from '../../shared/native-chat-types'
import { asRecord, extractString, parseJsonObject } from '../ai-vault/session-scanner-values'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'
import { acceptCodexRolloutRecord, type CodexRolloutScope } from '../../shared/codex-rollout-scope'

type CodexMessageOrigin = 'response' | 'legacy-event' | 'completed-item' | 'other'

export function codexTranscriptHistoryModeFromLine(line: string): string | null {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  return record?.type === 'session_meta' && payload
    ? (extractString(payload.history_mode) ?? null)
    : null
}

export function createCodexTranscriptHistoryDecoder(initialHistoryMode: string | null = null): ((
  line: string,
  fallbackId: string
) => NativeChatMessage | null) & {
  seedHistoryMode: (line: string) => void
} {
  let historyMode = initialHistoryMode
  const scope: CodexRolloutScope = {}
  let previousLegacyMessage: { origin: CodexMessageOrigin; key: string } | null = null

  const decode = (line: string, fallbackId: string): NativeChatMessage | null => {
    const record = parseJsonObject(line)
    if (record && !acceptCodexRolloutRecord(scope, record)) {
      return null
    }
    const payload = asRecord(record?.payload)
    if (record?.type === 'session_meta' && payload) {
      historyMode = extractString(payload.history_mode)
      previousLegacyMessage = null
      return null
    }
    const origin = codexMessageOrigin(record, payload)
    if (historyMode === 'paginated' && origin === 'response') {
      return null
    }
    const message = decodeCodexTranscriptLine(line, fallbackId)
    const key = message ? codexLegacyMessageKey(message) : null
    if (
      key &&
      historyMode !== 'paginated' &&
      previousLegacyMessage?.key === key &&
      previousLegacyMessage.origin !== origin &&
      (previousLegacyMessage.origin === 'response' || origin === 'response')
    ) {
      return null
    }
    previousLegacyMessage = key ? { origin, key } : previousLegacyMessage
    return message
  }
  decode.seedHistoryMode = (line: string): void => {
    const record = parseJsonObject(line)
    if (record) {
      acceptCodexRolloutRecord(scope, record)
    }
    historyMode = codexTranscriptHistoryModeFromLine(line)
    previousLegacyMessage = null
  }
  return decode
}

function codexMessageOrigin(
  record: Record<string, unknown> | null,
  payload: Record<string, unknown> | null
): CodexMessageOrigin {
  if (record?.type === 'response_item' && payload?.type === 'message') {
    return 'response'
  }
  if (
    record?.type === 'event_msg' &&
    (payload?.type === 'user_message' || payload?.type === 'agent_message')
  ) {
    return 'legacy-event'
  }
  if (record?.type === 'event_msg' && payload?.type === 'item_completed') {
    return 'completed-item'
  }
  return 'other'
}

function codexLegacyMessageKey(message: NativeChatMessage): string | null {
  return message.role === 'user' || message.role === 'assistant'
    ? `${message.role}\0${JSON.stringify(message.blocks)}`
    : null
}
