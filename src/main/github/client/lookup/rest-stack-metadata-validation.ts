export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}

export function isUsableRestStackMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const stack = value as {
    number?: unknown
    position?: unknown
    size?: unknown
    base?: unknown
  }
  if (!stack.base || typeof stack.base !== 'object' || Array.isArray(stack.base)) {
    return false
  }
  const base = stack.base as { ref?: unknown; sha?: unknown }
  return (
    isPositiveSafeInteger(stack.number) &&
    isPositiveSafeInteger(stack.position) &&
    isPositiveSafeInteger(stack.size) &&
    stack.position <= stack.size &&
    typeof base.ref === 'string' &&
    base.ref.trim().length > 0 &&
    (base.sha === undefined || isGitObjectId(base.sha))
  )
}
