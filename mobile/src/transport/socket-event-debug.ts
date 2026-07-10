// Why: RN's WebSocket close/error events are loosely typed and vary per
// platform. Serialize them defensively (circular-safe, function-safe,
// truncated) so the [net] diagnostics can never crash mid-handler.
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
