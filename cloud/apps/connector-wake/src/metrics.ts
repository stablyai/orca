// Metrics through Workers Analytics Engine (the edge's metrics.ts). Without the binding (local dev)
// this is a no-op. Counts only: never host ids.
import type { Env } from './env'

export type MetricEvent =
  // An accepted socket: label 'new' | 'replaced' (an older socket for the host was closed 4409).
  | 'socket_open'
  // label = close code the desktop or runtime gave.
  | 'socket_close'
  // Desktop-reported gap since its previous socket closed (x-orca-wake-gap-ms), value = ms.
  | 'reconnect_gap'
  // Every refusal the Worker or object sends: label '<status or code>', reason 'token' | 'country' | 'shape' | 'frame';
  // a 'token' refusal's detail is the check that failed (jwt.ts WAKE_REFUSE_CODES).
  | 'refuse'
  // Upgrade answered 503: label 'keys_unavailable' (no key set could be obtained) or
  // 'object_unavailable' (the forward to the host's object failed).
  | 'upgrade'
  // Pre-auth request refused by the per-source limiter: label 'wake' | 'health'.
  | 'preauth_limited'
  // POST /__admin/wake: label '<status>'; value = hosts in the batch.
  | 'admin'
  // Per-host wake outcome, label 'delivered' | 'no_socket' | 'error'; value = count in one batch.
  | 'wake'

// blobs: [event, label, version, reason, place, detail]; doubles: [value, ...extra]. place is the
// client's '<continent>/<colo>' (e.g. 'AS/HKG'), or the object's colo for per-object events. detail
// is a value from a fixed set (a 401 refusal's failed check, jwt.ts), or ''.
export function metric(env: Env, event: MetricEvent, value = 1, label = '', extra: number[] = [], reason = '', place = '', detail = ''): void {
  try {
    env.METRICS?.writeDataPoint({
      indexes: [event],
      blobs: [event, label, env.EDGE_VERSION ?? 'dev', reason, place, detail],
      doubles: [value, ...extra]
    })
  } catch {
    // Metrics must never affect the wake path.
  }
}

// From the Worker's request (cf is absent in local dev).
export function requestPlace(request: Request): string {
  const cf = (request as Request & { cf?: { colo?: string; continent?: string } }).cf
  if (!cf) { return 'local' }
  return `${cf.continent ?? '?'}/${cf.colo ?? '?'}`
}
