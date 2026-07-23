import {
  assertJsonTextStructureWithinLimits,
  type JsonTextStructureLimits
} from '../../../shared/json-text-structure-limit'
import { measureUtf8ByteLength } from '../../../shared/utf8-byte-limits'

export const ORCHESTRATION_QUERY_MAX_ROWS = 256
export const ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES = 2 * 1024 * 1024
export const ORCHESTRATION_QUERY_MAX_RETAINED_UTF8_BYTES = 8 * 1024 * 1024
export const ORCHESTRATION_WRITE_MAX_UTF8_BYTES = 512 * 1024
export const ORCHESTRATION_WRITE_MAX_ITEMS = 4096
export const ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES = 1024
export const ORCHESTRATION_JSON_STRUCTURE_LIMITS: JsonTextStructureLimits = {
  structuralTokens: 64 * 1024,
  nestingDepth: 64
}

export function parseOrchestrationJson(content: string): unknown {
  assertJsonTextStructureWithinLimits(content, ORCHESTRATION_JSON_STRUCTURE_LIMITS)
  return JSON.parse(content) as unknown
}

export function clampOrchestrationQueryLimit(
  requested: number | undefined,
  fallback = ORCHESTRATION_QUERY_MAX_ROWS
): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return Math.min(fallback, ORCHESTRATION_QUERY_MAX_ROWS)
  }
  return Math.min(ORCHESTRATION_QUERY_MAX_ROWS, Math.max(0, Math.floor(requested)))
}

export function orchestrationRowRetainedUtf8Bytes(row: object): number {
  let bytes = 0
  for (const value of Object.values(row)) {
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8')
    }
  }
  return bytes
}

export function retainOrchestrationQueryRows<T extends object>(
  rows: Iterable<T>,
  requestedLimit?: number
): T[] {
  const limit = clampOrchestrationQueryLimit(requestedLimit)
  if (limit === 0) {
    return []
  }
  const retained: T[] = []
  let retainedBytes = 0

  for (const row of rows) {
    const rowBytes = orchestrationRowRetainedUtf8Bytes(row)
    if (rowBytes > ORCHESTRATION_QUERY_MAX_ROW_UTF8_BYTES) {
      continue
    }
    if (retainedBytes + rowBytes > ORCHESTRATION_QUERY_MAX_RETAINED_UTF8_BYTES) {
      break
    }
    retained.push(row)
    retainedBytes += rowBytes
    if (retained.length >= limit) {
      break
    }
  }
  return retained
}

export function assertOrchestrationWriteFits(label: string, values: unknown[]): void {
  let retainedBytes = 0
  for (const value of values) {
    if (typeof value !== 'string') {
      continue
    }
    retainedBytes += Buffer.byteLength(value, 'utf8')
    if (retainedBytes > ORCHESTRATION_WRITE_MAX_UTF8_BYTES) {
      throw new Error(
        `${label} exceeds the ${ORCHESTRATION_WRITE_MAX_UTF8_BYTES}-byte orchestration limit`
      )
    }
  }
}

export function assertOrchestrationWaitTypeFilterFits(value: string | undefined): void {
  if (
    value &&
    measureUtf8ByteLength(value, {
      stopAfterBytes: ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES
    }).exceededLimit
  ) {
    throw new Error(
      `Message type filter exceeds the ${ORCHESTRATION_WAIT_TYPE_FILTER_MAX_UTF8_BYTES}-byte orchestration wait limit`
    )
  }
}

export function assertOrchestrationStringListFits(label: string, values: string[]): void {
  if (values.length > ORCHESTRATION_WRITE_MAX_ITEMS) {
    throw new Error(
      `${label} exceeds the ${ORCHESTRATION_WRITE_MAX_ITEMS}-item orchestration limit`
    )
  }
  assertOrchestrationWriteFits(label, values)
}

export function truncateOrchestrationDiagnostic(value: string): string {
  if (Buffer.byteLength(value, 'utf8') <= ORCHESTRATION_WRITE_MAX_UTF8_BYTES) {
    return value
  }

  let bytes = 0
  let end = 0
  for (const codePoint of value) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + codePointBytes > ORCHESTRATION_WRITE_MAX_UTF8_BYTES) {
      break
    }
    bytes += codePointBytes
    end += codePoint.length
  }
  return value.slice(0, end)
}
