export function addLifecycleRejectionMarker(
  payload: string | null,
  code: string,
  reason: string
): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value: unknown = payload ? JSON.parse(payload) : {}
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>
    }
  } catch {
    // Authority reconciliation only reaches this path with object payloads.
  }
  return JSON.stringify({
    ...parsed,
    _orcaLifecycleRejection: { code, reason }
  })
}

export function hasLifecycleRejectionMarker(payload: string | null): boolean {
  try {
    const value: unknown = JSON.parse(payload ?? 'null')
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false
    }
    const marker = (value as Record<string, unknown>)._orcaLifecycleRejection
    return Boolean(
      marker &&
      typeof marker === 'object' &&
      !Array.isArray(marker) &&
      typeof (marker as Record<string, unknown>).code === 'string' &&
      typeof (marker as Record<string, unknown>).reason === 'string'
    )
  } catch {
    return false
  }
}
