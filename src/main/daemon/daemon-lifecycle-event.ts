// App-side emitters for the `daemon_lifecycle` telemetry event (STA-2376). Kept out of daemon-init
// so the replace/retire call sites stay one line and this stays a clean unit-test/mocking seam.
// No-op in dev/contributor builds (see telemetry/client `track`); rare in the field (≪1/user/day).

import {
  bucketDaemonLiveSessionCount,
  type DaemonReplaceReason,
  type DaemonRetireReason
} from '../../shared/daemon-lifecycle-telemetry'
import { track } from '../telemetry/client'

// Why: both call sites sit on the daemon launch/respawn path, where a throw costs the user every
// terminal. Diagnostics must never be able to do that, so failures die here.
function trackQuietly(props: Parameters<typeof track<'daemon_lifecycle'>>[1]): void {
  try {
    track('daemon_lifecycle', props)
  } catch {
    // Telemetry is best-effort; a dropped event must not fail a daemon launch.
  }
}

// Replaced a still-connectable daemon (startup launcher decided to kill and re-fork it).
export function trackDaemonReplaced(
  reason: DaemonReplaceReason,
  liveSessionCount: number | null
): void {
  trackQuietly({
    transition: 'replaced',
    reason,
    live_session_count_bucket: bucketDaemonLiveSessionCount(liveSessionCount)
  })
}

// Adapter observed the daemon die and forked a replacement; the app can't see the daemon-internal
// exit cause, so the live-session count is unknowable here and buckets to `unknown`.
export function trackDaemonRetired(reason: DaemonRetireReason): void {
  trackQuietly({
    transition: 'retired',
    reason,
    live_session_count_bucket: bucketDaemonLiveSessionCount(null)
  })
}
