import type { AiVaultSession } from '../../shared/ai-vault-types'
import { asRecord } from './session-scanner-record-value'
import type { OpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-protocol'
import type { TranscriptMessage } from './session-transcript-consumers'

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  const record = asRecord(value)
  return (
    record !== null &&
    (record.role === 'user' || record.role === 'assistant' || record.role === 'tool') &&
    typeof record.text === 'string' &&
    (record.timestamp === null || typeof record.timestamp === 'string')
  )
}

/** Drop malformed messages while retaining indexable content from the rest of the capture. */
export function parseOpenCodeSqliteCaptureValue(value: unknown): OpenCodeSqliteCaptureValue {
  const record = asRecord(value)
  if (!record) {
    return { session: null, messages: [] }
  }
  const messages = Array.isArray(record.messages) ? record.messages.filter(isTranscriptMessage) : []
  // Match parse-leg trust in session metadata so capture validation does not exclude otherwise listed sessions.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker builds this with the repo's own reader; only the structured clone sits between.
  const session = (record.session ?? null) as AiVaultSession | null
  return { session, messages }
}
