function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

export function runWithSettingsSyncSuppressed<T>(
  operation: () => T,
  begin: () => void,
  end: () => void
): T {
  begin()
  try {
    const result = operation()
    if (isPromiseLike(result)) {
      return Promise.resolve(result).finally(end) as T
    }
    end()
    return result
  } catch (error) {
    end()
    throw error
  }
}
