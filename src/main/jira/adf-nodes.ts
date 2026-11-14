export type AdfRecord = Record<string, unknown>

export function adfRecord(value: unknown): AdfRecord {
  return value && typeof value === 'object' ? (value as AdfRecord) : {}
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
