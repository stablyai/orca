export type JsonRecord = Record<string, unknown>

export function isJsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function asRecord(value: unknown): JsonRecord | null {
  return isJsonRecord(value) ? value : null
}
