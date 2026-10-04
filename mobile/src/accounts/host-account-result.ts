// Missing results and nested refusals without snapshot members are not account evidence.
export function isHostAccountResult(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    !(
      typeof value === 'object' &&
      'error' in value &&
      !('claude' in value || 'codex' in value || 'rateLimits' in value)
    )
  )
}
