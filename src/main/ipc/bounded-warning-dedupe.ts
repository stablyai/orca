export const DEFAULT_WARNING_DEDUPE_MAX_KEYS = 256

// Bound dynamic path/provider keys while suppressing repeated diagnostics.
export function shouldEmitBoundedWarning(
  warningKeys: Set<string>,
  key: string,
  maxKeys = DEFAULT_WARNING_DEDUPE_MAX_KEYS
): boolean {
  if (warningKeys.has(key)) {
    return false
  }
  // Eviction during repeated max+1 scans would re-emit every warning.
  if (warningKeys.size >= maxKeys) {
    return true
  }
  warningKeys.add(key)
  return true
}
