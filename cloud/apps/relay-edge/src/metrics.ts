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

// blobs: [event, label, version]; doubles: [value, ...extra]. One index per event for sampling.
// Heartbeat events fire per host every ping interval; keep 1 in 10 (multiply counts by 10).
const HEARTBEAT_SAMPLE = 0.1

export function metric(env: Env, event: MetricEvent, value = 1, label = '', extra: number[] = []): void {
  if ((event === 'alarm_lag_ms' || event === 'pong_rtt_ms') && Math.random() >= HEARTBEAT_SAMPLE) return
  try {
    env.METRICS?.writeDataPoint({
      indexes: [event],
      blobs: [event, label, env.EDGE_VERSION ?? 'dev'],
      doubles: [value, ...extra]
    })
  } catch {
    // Metrics must never affect the relay path.
  }
}
