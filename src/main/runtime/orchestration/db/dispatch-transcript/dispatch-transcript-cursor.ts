import { OrchestrationError } from '../../orchestration-error'
import type { DispatchTranscriptReadSelector } from './dispatch-transcript-types'

const PREFIX = 'dtr1_'
const MAX_CURSOR_LENGTH = 2_048

export type DispatchTranscriptContinuation = {
  segmentIndex: number
  position: number
}

export function encodeDispatchTranscriptCursor(params: {
  dispatchId: string
  selector: DispatchTranscriptReadSelector
  segmentIndex: number
  position: number
}): string {
  const payload = {
    v: 1,
    d: params.dispatchId,
    s: selectorKey(params.selector),
    i: params.segmentIndex,
    p: params.position
  }
  return `${PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

export function decodeDispatchTranscriptCursor(
  cursor: string | undefined,
  dispatchId: string,
  selector: DispatchTranscriptReadSelector
): DispatchTranscriptContinuation | null {
  if (!cursor) {
    return null
  }
  if (cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(PREFIX)) {
    throw invalidCursor()
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(cursor.slice(PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw invalidCursor()
  }
  if (!isCursorPayload(value)) {
    throw invalidCursor()
  }
  if (value.d !== dispatchId || value.s !== selectorKey(selector)) {
    throw new OrchestrationError(
      'cursor_dispatch_mismatch',
      'The transcript cursor belongs to a different Dispatch or history selection.'
    )
  }
  return { segmentIndex: value.i, position: value.p }
}

function selectorKey(selector: DispatchTranscriptReadSelector): string {
  return selector.kind === 'predecessor' ? `predecessor:${selector.dispatchId}` : selector.kind
}

function isCursorPayload(
  value: unknown
): value is { v: 1; d: string; s: string; i: number; p: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const payload = value as Record<string, unknown>
  return (
    payload.v === 1 &&
    typeof payload.d === 'string' &&
    typeof payload.s === 'string' &&
    Number.isSafeInteger(payload.i) &&
    Number(payload.i) >= 0 &&
    Number.isSafeInteger(payload.p) &&
    Number(payload.p) >= 0
  )
}

function invalidCursor(): OrchestrationError {
  return new OrchestrationError('cursor_invalid', 'The transcript cursor is invalid.')
}
