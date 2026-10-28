import {
  bucketDaemonLiveSessionCount,
  type DaemonReplaceReason,
  type DaemonRetireReason
} from '../../shared/daemon-lifecycle-telemetry'
import { track } from '../telemetry/client'

function trackQuietly(props: Parameters<typeof track<'daemon_lifecycle'>>[1]): void {
  try {
    track('daemon_lifecycle', props)
  } catch {
    // Telemetry failures must not abort daemon launch or respawn.
  }
}

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

// The app cannot observe the retired daemon's live-session count.
export function trackDaemonRetired(reason: DaemonRetireReason): void {
  trackQuietly({
    transition: 'retired',
    reason,
    live_session_count_bucket: bucketDaemonLiveSessionCount(null)
  })
}
