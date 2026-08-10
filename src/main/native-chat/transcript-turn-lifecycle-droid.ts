import type { NativeChatTurnLifecycle } from '../../shared/native-chat-types'
import { isNoiseMessage } from '../../shared/native-chat-noise'
import {
  asRecord,
  extractString,
  parseJsonObject,
  timestampMs
} from '../ai-vault/session-scanner-values'
import { decodeDroidTranscriptLine } from './transcript-line-decoders-droid'

/**
 * Droid turn boundaries. Unlike Grok and omp, Droid publishes an explicit
 * per-turn verdict (`agent_turn_outcome`), so the chat spinner can settle on
 * provider evidence instead of trailing assistant prose.
 *
 * Known gap: that record carries no timestamp, so a terminal marker is trusted
 * unconditionally (see `lifecycleTerminatesCurrentTurn`). The next prompt's own
 * `working` marker — which does carry the row's timestamp — restores the
 * spinner, so the exposure is the sub-second window between a prompt's hook and
 * its transcript flush.
 */
export function decodeDroidTurnLifecycle(
  line: string,
  fallbackId: string
): NativeChatTurnLifecycle | null {
  const record = parseJsonObject(line)
  if (!record) {
    return null
  }
  if (record.type === 'agent_turn_outcome') {
    const reason = extractString(record.reason)
    if (reason !== 'completed' && reason !== 'cancelled') {
      return null
    }
    return {
      state: reason === 'cancelled' ? 'interrupted' : 'completed',
      turnId: extractString(record.turnId) ?? fallbackId,
      timestamp: lifecycleTimestamp(record.timestamp)
    }
  }
  if (record.type !== 'message' || asRecord(record.message)?.role !== 'user') {
    return null
  }
  const decoded = decodeDroidTranscriptLine(line, fallbackId)
  // Why: only a user-authored prompt opens a generation. Tool results arrive as
  // user rows too (decoded to role `tool`), and harness-injected turns fire the
  // same hooks without being prompts — treating either as working would overwrite
  // a real terminal marker and re-stick the spinner after done/interrupt.
  if (decoded?.role !== 'user' || isNoiseMessage(decoded)) {
    return null
  }
  return { state: 'working', turnId: decoded.id, timestamp: decoded.timestamp ?? null }
}

function lifecycleTimestamp(value: unknown): number | null {
  const parsed = timestampMs(value)
  return Number.isFinite(parsed) ? parsed : null
}
