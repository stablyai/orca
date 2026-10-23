import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { PostHog } from 'posthog-node'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CommonProps, EventName } from '../../shared/telemetry-events'
import type { ConsentState } from './consent'

const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000

export function buildCommonProps(
  installId: string,
  sid: string,
  channel: 'stable' | 'rc'
): CommonProps {
  // Don't truncate here; the validator's `.max(64)` is authoritative, so an over-long string drops rather than being silently masked.
  return {
    app_version: getAppEnvironment().getVersion(),
    platform: osPlatform(),
    arch: osArch(),
    os_release: osRelease(),
    install_id: installId,
    session_id: sid,
    orca_channel: channel
  }
}

export function waitForCaptureEnqueue(
  client: PostHog,
  event: EventName,
  uuid: string
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let stopListening: (() => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (enqueued: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      stopListening?.()
      resolve(enqueued)
    }

    // Why: posthog-node capture() enqueues async; this SDK event is the durable boundary before optOut().
    stopListening = client.on('capture', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      if (
        'event' in payload &&
        payload.event === event &&
        'uuid' in payload &&
        payload.uuid === uuid
      ) {
        settle(true)
      }
    })

    timeout = setTimeout(() => settle(false), OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS)
  })
}

/**
 * Whether to flip the PostHog SDK's in-memory `optedOut` flag at boot.
 *
 * True for DISABLED cohorts only, re-applied every boot (the flag doesn't persist) so any direct
 * `posthog.capture()` bypassing `track()` still drops for an opted-out user. Deliberately excludes
 * `pending_banner`: the direct `telemetry_opted_out` capture in `setOptIn(_, false)` must not drop,
 * or we'd lose the one signal that the opt-out flow works.
 */
export function shouldOptOutSdkAtInit(consent: ConsentState): boolean {
  return consent.effective === 'disabled'
}

export function createPostHogClient(writeKey: string, consent: ConsentState): PostHog {
  const client = new PostHog(writeKey, {
    host: 'https://us.i.posthog.com',
    flushAt: 20,
    flushInterval: 10_000,
    // Strip SDK-auto GeoIP / client-IP enrichment; our wire is exactly CommonProps ∪ EventProps ∪ a small allow-list.
    disableGeoip: true,
    // Bumped from the default 1000 (drops oldest-first past cap) to 5000 to tolerate long-offline sessions.
    maxQueueSize: 5000
  })

  if (shouldOptOutSdkAtInit(consent)) {
    client.optOut()
  }
  return client
}
