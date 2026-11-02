import { createHash } from 'node:crypto'
import { OrchestrationError } from './orchestration-error'

const WORKER_OUTPUT_CURSOR_PREFIX = 'owr1_'
const WORKER_OUTPUT_CURSOR_MAX_LENGTH = 2_048

type WorkerOutputCursorPayload = {
  v: 1
  d: string
  s: 'terminal' | 'transcript'
  i: string
  p: number
  c?: string
}

export type DecodedWorkerOutputCursor =
  | {
      source: 'terminal'
      sourceIdentity: string | null
      position: number
      legacy: boolean
    }
  | {
      source: 'transcript'
      sourceIdentity: string
      position: number
      boundaryCheckpoint: string | null
      legacy: false
    }

export function createWorkerOutputSourceIdentity(fields: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('base64url').slice(0, 32)
}

export function encodeWorkerOutputCursor(
  dispatchId: string,
  source: WorkerOutputCursorPayload['s'],
  sourceIdentity: string,
  position: number,
  boundaryCheckpoint?: string
): string {
  const payload: WorkerOutputCursorPayload = {
    v: 1,
    d: dispatchId,
    s: source,
    i: sourceIdentity,
    p: position,
    ...(source === 'transcript' && boundaryCheckpoint ? { c: boundaryCheckpoint } : {})
  }
  return `${WORKER_OUTPUT_CURSOR_PREFIX}${Buffer.from(JSON.stringify(payload)).toString('base64url')}`
}

export function decodeWorkerOutputCursor(
  cursor: string | number | undefined,
  dispatchId: string
): DecodedWorkerOutputCursor | null {
  if (cursor === undefined) {
    return null
  }
  if (typeof cursor === 'number') {
    return decodeLegacyTerminalCursor(cursor)
  }
  if (/^\d+$/.test(cursor)) {
    return decodeLegacyTerminalCursor(Number.parseInt(cursor, 10))
  }
  if (
    cursor.length > WORKER_OUTPUT_CURSOR_MAX_LENGTH ||
    !cursor.startsWith(WORKER_OUTPUT_CURSOR_PREFIX)
  ) {
    throw invalidCursor()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(
      Buffer.from(cursor.slice(WORKER_OUTPUT_CURSOR_PREFIX.length), 'base64url').toString('utf8')
    )
  } catch {
    throw invalidCursor()
  }
  if (!isWorkerOutputCursorPayload(parsed)) {
    throw invalidCursor()
  }
  if (parsed.d !== dispatchId) {
    throw new OrchestrationError(
      'cursor_dispatch_mismatch',
      'The worker-read cursor belongs to a different Dispatch.'
    )
  }
  return parsed.s === 'transcript'
    ? {
        source: 'transcript',
        sourceIdentity: parsed.i,
        position: parsed.p,
        boundaryCheckpoint: parsed.c ?? null,
        legacy: false
      }
    : {
        source: 'terminal',
        sourceIdentity: parsed.i,
        position: parsed.p,
        legacy: false
      }
}

function decodeLegacyTerminalCursor(position: number): DecodedWorkerOutputCursor {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw invalidCursor()
  }
  return { source: 'terminal', sourceIdentity: null, position, legacy: true }
}

function isWorkerOutputCursorPayload(value: unknown): value is WorkerOutputCursorPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const payload = value as Record<string, unknown>
  return (
    payload.v === 1 &&
    typeof payload.d === 'string' &&
    payload.d.length > 0 &&
    payload.d.length <= 512 &&
    (payload.s === 'terminal' || payload.s === 'transcript') &&
    typeof payload.i === 'string' &&
    payload.i.length > 0 &&
    payload.i.length <= 128 &&
    typeof payload.p === 'number' &&
    Number.isSafeInteger(payload.p) &&
    payload.p >= 0 &&
    (payload.c === undefined ||
      (payload.s === 'transcript' &&
        typeof payload.c === 'string' &&
        payload.c.length > 0 &&
        payload.c.length <= 128))
  )
}

function invalidCursor(): OrchestrationError {
  return new OrchestrationError('cursor_invalid', 'The worker-read cursor is invalid.')
}
