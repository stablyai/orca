export function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}
