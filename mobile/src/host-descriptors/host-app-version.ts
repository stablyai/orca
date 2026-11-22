const MAX_VERSION_LENGTH = 64

// Normalize independently of storage for every build; bound length and reject newlines to protect diagnostics and device storage.
export function normalizeHostAppVersion(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (
    normalized.length === 0 ||
    normalized.length > MAX_VERSION_LENGTH ||
    normalized.includes('\n') ||
    normalized.includes('\r')
  ) {
    return null
  }
  return normalized
}
