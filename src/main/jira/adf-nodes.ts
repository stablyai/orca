export type AdfRecord = Record<string, unknown>

function isAdfRecord(value: unknown): value is AdfRecord {
  return value !== null && typeof value === 'object'
}

export function adfRecord(value: unknown): AdfRecord {
  return isAdfRecord(value) ? value : {}
}

export function adfChildren(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function adfString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function adfPositiveInteger(value: unknown, fallback = 1): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback
}
