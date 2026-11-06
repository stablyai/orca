// Spike metrics through Workers Analytics Engine. Without the binding (local dev) this is a no-op.
import type { Env } from './env'

export type MetricEvent =
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
  // Director admin calls: label '<op>:<outcome or status>'.
  | 'admin'

// blobs: [event, label, version]; doubles: [value, ...extra]. One index per event for sampling.
// Heartbeat events fire per host every ping interval; keep 1 in 10 (multiply counts by 10).
const HEARTBEAT_SAMPLE = 0.1

export function metric(env: Env, event: MetricEvent, value = 1, label = '', extra: number[] = [], reason = ''): void {
  if ((event === 'alarm_lag_ms' || event === 'pong_rtt_ms') && Math.random() >= HEARTBEAT_SAMPLE) return
  try {
    env.METRICS?.writeDataPoint({
      indexes: [event],
      blobs: [event, label, env.EDGE_VERSION ?? 'dev', reason],
      doubles: [value, ...extra]
    })
  } catch {
    // Metrics must never affect the relay path.
  }
}
