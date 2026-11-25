// Spike metrics through Workers Analytics Engine. Without the binding (local dev) this is a no-op.
import type { Env } from './env'

export type MetricEvent =
  // label 'new' | 'rebind'; reason 'keepalive' | 'legacy' (took the keepalive offer or not);
  // double2 = ms from the upgrade to activation (the desktop gives up a connect after 15 s).
  | 'control_active'
  | 'control_close'
  | 'phone_open'
  | 'phone_close'
  | 'alarm_lag_ms'
  | 'pong_rtt_ms'
  | 'splice_bytes'
  // Every close the edge sends: label '<role>:<code>', reason in blob 4. Alerts: 4401 share, 4429/4503 spikes.
  | 'refuse'
  // One per database operation: label 'ok' | 'transient' | 'error', value = ms (Hyperdrive latency, R6).
  | 'db_op'
  // Object backend daily sweep: label 'swept' | 'wiped'.
  | 'sweep'
  // Erasure index write from a host object's alarm (user-index.ts): label 'ok' | 'retry' |
  // 'unbound' (no USER_HOSTS binding in this deploy). Dark: only with the director endpoints on.
  | 'user_index'
  // Director admin calls: label '<op>:<outcome or status>' ('<op>:replay' for a reused jti).
  | 'admin'
  // Admin call accepted from a token without a jti (transitional, admin.ts): label '<op>'.
  | 'admin_no_jti'
  // Host auth-refresh frame: label 'extended' | 'unchanged' | 'invalid' | 'identity_changed' |
  // 'keys_unavailable' (no relay JWKS to judge it; the socket stays, unchanged).
  | 'auth_refresh'
  // Control upgrade answered 503 because no relay JWKS could be obtained: label 'keys_unavailable'.
  | 'control_upgrade'
  // Control closed 4401 for expired authorization: value = seconds since its last extending
  // refresh, label 'refreshed'; -1 and label 'never' when this socket never extended its token.
  // double2 = seconds since the host's last inbound frame or keepalive, double3 = seconds since the
  // control became active (-1 if unknown); reason 'keepalive' | 'legacy'.
  | 'auth_expired_close'
  // Control closed for silence (deadControlMetric, host-relay-control.ts).
  | 'silence_close'
  // A host's control came back after its last control closed: value = seconds from when that
  // control was last known alive (silence closes) or closed (others) to this activation; label =
  // that close code; double2 = seconds between last-known-alive and the actual close.
  // reason 'keepalive' | 'legacy' of the new control.
  | 'reconnect_gap'
  // Pre-auth socket refused by the per-source limiter: label 'phone' | 'data' | 'health' | 'resolve'. Unpushed-host phones: 'not_on_edge'.
  | 'preauth_limited'
  | 'not_on_edge'
  // A request carried an ingress header that failed to verify (wrong secret, skew, malformed).
  | 'ingress_refused'
  // A request from a token-mode front door's egress ranges that failed the trust rule: answered 403.
  | 'ingress_rejected'
  // An ingress mode is configured but malformed, so it is off: label names the problem (per isolate).
  | 'ingress_config_invalid'
  // Edge-native director endpoints (director.ts): label '<route>:<status>' ('assign:200',
  // 'connect:101'), or 'config:<problem>' for a malformed DIRECTOR_* setup (per isolate).
  | 'director'

// blobs: [event, label, version, reason, place]; doubles: [value, ...extra]. place is the
// client's ingress '<continent>/<colo>' (e.g. 'AS/HKG'), '' where no client is involved. A verified
// ingress hop appends the client's country (as the ingress reports it, else the hop's) and the hop's
// name: 'AS/HKG/CN/cn' (continent/colo are then the hop's). One index per event for sampling.
// Heartbeat events (alarm_lag_ms, pong_rtt_ms) fire per host every ping interval; only 1 in
// HEARTBEAT_FACTOR is written, and Analytics Engine's _sample_interval does not know that. Those
// two events carry the factor as their last double (double2, as they pass no extra), so a count
// is sum(_sample_interval * double2). No other event has it.
const HEARTBEAT_FACTOR = 10

export function metric(env: Env, event: MetricEvent, value = 1, label = '', extra: number[] = [], reason = '', place = ''): void {
  const heartbeat = event === 'alarm_lag_ms' || event === 'pong_rtt_ms'
  if (heartbeat && Math.random() >= 1 / HEARTBEAT_FACTOR) { return }
  try {
    env.METRICS?.writeDataPoint({
      indexes: [event],
      blobs: [event, label, env.EDGE_VERSION ?? 'dev', reason, place],
      doubles: heartbeat ? [value, ...extra, HEARTBEAT_FACTOR] : [value, ...extra]
    })
  } catch {
    // Metrics must never affect the relay path.
  }
}

// From the Worker's request (cf is absent in local dev).
export function requestPlace(request: Request, ingress?: { name: string; country?: string } | null): string {
  const cf = (request as Request & { cf?: { colo?: string; continent?: string; country?: string } }).cf
  if (!cf) { return ingress ? `local/${ingress.name}` : 'local' }
  const place = `${cf.continent ?? '?'}/${cf.colo ?? '?'}`
  return ingress ? `${place}/${ingress.country ?? cf.country ?? '?'}/${ingress.name}` : place
}
