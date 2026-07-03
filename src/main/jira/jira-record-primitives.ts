export type JiraRecord = Record<string, unknown>

export function asRecord(value: unknown): JiraRecord {
  return value && typeof value === 'object' ? (value as JiraRecord) : {}
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}
