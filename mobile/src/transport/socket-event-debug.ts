// RN socket event shapes vary by platform; serialize defensively so diagnostics cannot crash event handlers.
export function describeSocketEvent(event: unknown): { keys: string[]; json: string } {
  let keys: string[] = []
  try {
    keys = event && typeof event === 'object' ? Object.keys(event as object) : []
  } catch {
    keys = []
  }
  let json = ''
  try {
    const seen = new WeakSet<object>()
    json = JSON.stringify(
      event,
      (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v as object)) {
            return '[circular]'
          }
          seen.add(v as object)
        }
        if (typeof v === 'function') {
          return '[fn]'
        }
        return v
      },
      0
    ).slice(0, 500)
  } catch {
    json = '[unstringifiable]'
  }
  return { keys, json }
}

export function redactSocketEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host || 'unknown'
  } catch {
    return 'unknown'
  }
}
