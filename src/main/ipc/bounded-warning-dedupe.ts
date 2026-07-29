export const DEFAULT_WARNING_DEDUPE_MAX_KEYS = 256

// Why: diagnostic "warn once" keys often include dynamic paths/providers; keep
// repeated warnings quiet without retaining every stale key forever.
export function shouldEmitBoundedWarning(
  warningKeys: Set<string>,
  key: string,
  maxKeys = DEFAULT_WARNING_DEDUPE_MAX_KEYS
): boolean {
  if (warningKeys.has(key)) {
    return false
  }
  // Why: evicting during a stable max+1 scan cascades into re-emitting every warning.
  if (warningKeys.size >= maxKeys) {
    return true
  }
  warningKeys.add(key)
  return true
}
