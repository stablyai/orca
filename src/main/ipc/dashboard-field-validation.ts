export function isBoundedString(
  value: unknown,
  maxLength: number,
  allowEmpty = false
): value is string {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.length > 0)
}

export function isOptionalBoundedString(value: unknown, maxLength: number): boolean {
  return value === undefined || isBoundedString(value, maxLength, true)
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

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
