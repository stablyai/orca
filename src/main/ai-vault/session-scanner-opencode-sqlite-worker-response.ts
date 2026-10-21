import type { AiVaultSession } from '../../shared/ai-vault-types'
import { asRecord } from './session-scanner-record-value'
import type { OpenCodeSqliteCaptureValue } from './session-scanner-opencode-sqlite-worker-protocol'
import type { TranscriptMessage } from './session-transcript-consumers'

// Why: a worker posts back a structured clone, which arrives as `unknown`. The
// messages are checked one by one because they are written into the index as
// rows keyed by role, and a value with no role at all would land under none.

function isTranscriptMessage(value: unknown): value is TranscriptMessage {
  const record = asRecord(value)
  return (
    record !== null &&
    (record.role === 'user' || record.role === 'assistant' || record.role === 'tool') &&
    typeof record.text === 'string' &&
    (record.timestamp === null || typeof record.timestamp === 'string')
  )
}

/**
 * Read a `capture` response from the OpenCode SQLite worker.
 *
 * A message that is not one is dropped rather than failing the read: the rest
 * of the session is still worth indexing, and a row with a role the index has
 * no column for would be written under an empty one.
 * @param value - The worker's response value.
 * @returns The session and the messages the response carried.
 */
export function parseOpenCodeSqliteCaptureValue(value: unknown): OpenCodeSqliteCaptureValue {
  const record = asRecord(value)
  if (!record) {
    return { session: null, messages: [] }
  }
  const messages = Array.isArray(record.messages) ? record.messages.filter(isTranscriptMessage) : []
  // Held to the same standard as the parse leg rather than validated harder: a
  // session this build dropped here but kept there would be in the panel and
  // absent from the index, which is worse than trusting our own worker.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the worker builds this with the repo's own reader; only the structured clone sits between.
  const session = (record.session ?? null) as AiVaultSession | null
  return { session, messages }
}
