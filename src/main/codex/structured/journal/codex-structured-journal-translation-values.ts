export function readCodexJournalRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

export function readCodexJournalString(
  source: Record<string, unknown>,
  key: string
): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}
