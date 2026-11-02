// Telemetry must never fail a health read, so every error stops here.

import { getAppEnvironment } from '../../shared/app-environment'
import { classifyDaemonAppVersionMatch } from '../../shared/daemon-adoption-telemetry'
import type { DaemonAsyncIoHealth } from '../../shared/daemon-async-io-health'
import type { DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS } from '../../shared/telemetry-daemon-event-schemas'
import { track } from '../telemetry/client'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'

type StallObservation = { stalledAtMs: number; recovered: boolean }

// Keyed by launch nonce so reconnects and multiple polling windows share one record per incarnation.
const observedStalls = new Map<string, StallObservation>()

function bucketStallDuration(ms: number): (typeof DAEMON_ASYNC_IO_STALL_DURATION_BUCKETS)[number] {
  return ms < 60_000 ? '<1m' : ms < 300_000 ? '1-5m' : ms < 1_800_000 ? '5-30m' : '30m+'
}

/** Emits at most one `stalled` and one later `recovered` per daemon incarnation. */
export function observeDaemonAsyncIoHealth(
  identity: DaemonEndpointIdentity,
  protocolVersion: number,
  health: DaemonAsyncIoHealth,
  nowMs: number = Date.now()
): void {
  try {
    const seen = observedStalls.get(identity.launchNonce)
    const isTransition = health.state === 'stalled' ? !seen : seen?.recovered === false
    if (!isTransition) {
      return
    }
    const base = {
      protocol_generation: protocolVersion,
      app_version_match: classifyDaemonAppVersionMatch(
        identity.appVersion,
        getAppEnvironment().getVersion()
      )
    }
    if (!seen) {
      // Record only a delivered stall so a pre-init poll can report it later.
      if (track('daemon_async_io_health', { transition: 'stalled', ...base })) {
        observedStalls.set(identity.launchNonce, { stalledAtMs: nowMs, recovered: false })
      }
      return
    }
    seen.recovered = true
    track('daemon_async_io_health', {
      transition: 'recovered',
      ...base,
      stalled_for_bucket: bucketStallDuration(nowMs - seen.stalledAtMs)
    })
  } catch {
    // Telemetry is best-effort; a dropped event must not fail a health read.
  }
}
