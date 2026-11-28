/** ZCode headless `--output-format stream-json` writes one JSON record per line on stdout, then a
 *  terminal `result` record. These readers keep that contract in one place: unknown fields are
 *  retained, nothing is inferred from the TUI. See zcode-app-cli docs/HEADLESS.md. */

export type ZcodeStreamRecord = {
  /** `session.titleUpdated`, `turn.started`, `model.streaming`, `session.updated`, `turn.completed`, ... */
  type: string
  payload?: Record<string, unknown>
  sessionId?: string
  turnId?: string
  seq?: number
  timestamp?: number
}

/** The terminal record; its presence (with exit 0) is the only proof a prompt completed. */
export type ZcodeResultRecord = {
  type: 'result'
  sessionId?: string
  turnId?: string
  response?: string
  eventCount?: number
  projection?: {
    status?: string
    turnCount?: number
    totalTokenCount?: number
    contextUsed?: number
    contextWindow?: number
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isZcodeStreamRecord(value: unknown): value is ZcodeStreamRecord {
  return isObject(value) && typeof value.type === 'string'
}

/** A record with a string `type`; null for anything else (blank lines, torn writes). */
export function parseZcodeStreamRecord(line: string): ZcodeStreamRecord | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) {
    return null
  }
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return null
  }
  return isZcodeStreamRecord(value) ? value : null
}

export function isZcodeResultRecord(value: unknown): value is ZcodeResultRecord {
  return isObject(value) && value.type === 'result'
}

/** `model.streaming` splits one assistant message into typed deltas (`text_delta`,
 *  `reasoning_delta`, ...). */
export type ZcodeStreamingPayload = {
  kind?: string
  delta?: string
  done?: boolean
  assistantMessageId?: string
  toolName?: string
}

export function zcodeStreamingPayload(record: ZcodeStreamRecord): ZcodeStreamingPayload | null {
  if (record.type !== 'model.streaming' || !isObject(record.payload)) {
    return null
  }
  const payload = record.payload
  return {
    ...(typeof payload.kind === 'string' ? { kind: payload.kind } : {}),
    ...(typeof payload.delta === 'string' ? { delta: payload.delta } : {}),
    ...(typeof payload.toolName === 'string' ? { toolName: payload.toolName } : {})
  }
}

/** The provider's own conversation id (`sess_...`); present on most records. */
export function zcodeRecordSessionId(record: ZcodeStreamRecord): string | null {
  return typeof record.sessionId === 'string' && record.sessionId.length > 0
    ? record.sessionId
    : typeof record.payload?.sessionId === 'string'
      ? record.payload.sessionId
      : null
}
