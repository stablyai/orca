/** IPC limits use JavaScript string units; required identifiers must remain nonempty. */
export function isBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false
): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

/** Optional wire labels accept absence and blank text, while null remains invalid. */
export function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

/** Require finite IPC numbers so invalid timestamps cannot enter dashboard ordering or rendering. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Older producers may omit the route; a supplied route must name a bounded session and a local or runtime target. */
export function isDashboardChatSession(value: unknown, maxIdLength: number): boolean {
  if (value === undefined) {
    return true
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('sessionId' in value) ||
    !('target' in value)
  ) {
    return false
  }
  const target = value.target
  return (
    isBoundedString(value.sessionId, maxIdLength) &&
    !!target &&
    typeof target === 'object' &&
    !Array.isArray(target) &&
    'kind' in target &&
    (target.kind === 'local' ||
      (target.kind === 'environment' &&
        'environmentId' in target &&
        isBoundedString(target.environmentId, maxIdLength)))
  )
}
