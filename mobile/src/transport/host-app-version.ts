const MAX_VERSION_LENGTH = 64

/**
 * A host's self-reported app version as anything may hold it, or null.
 *
 * Beside the store rather than inside it because the two have different hosts: every build reads a
 * version off `status.get`, and only a build with a device store keeps one. The bounds are the
 * reasons a reported string is unusable at all — a newline splices a line into a diagnostics
 * report, and an unbounded one is a host deciding how much of this device's storage to spend.
 */
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
