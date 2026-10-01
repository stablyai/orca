export function isSentryRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sentryRecord(value: unknown): Record<string, unknown> {
  return isSentryRecord(value) ? value : {}
}

export function sentryArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}
