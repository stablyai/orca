import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import type * as PostHogSdk from 'posthog-node'
import { getAppEnvironment } from '../../shared/app-environment'
import { getMainHttpClient } from '../network/http-client'
import type { CommonProps, EventName } from '../../shared/telemetry-events'
import type { ConsentState } from './consent'

const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000
export const POSTHOG_FLUSH_AT = 20
export const POSTHOG_FLUSH_INTERVAL_MS = 10_000

export function buildCommonProps(
  installId: string,
  sid: string,
  channel: 'stable' | 'rc'
): CommonProps {
  // Let authoritative max(64) validation drop overlong versions; truncation would hide invalid data.
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
  client: PostHogSdk.PostHog,
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

    // Node SDK capture enqueues asynchronously; observe its event before opting out.
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

/** Reapply SDK opt-out each boot for disabled users. Keep pending-banner SDK enabled so the direct Turn Off capture can enqueue before optOut. */
export function shouldOptOutSdkAtInit(consent: ConsentState): boolean {
  return consent.effective === 'disabled'
}

// Load the SDK with the client; requiring it at startup costs ~58ms before any window (#35752).
function loadPostHogSdk(): typeof PostHogSdk {
  return require('posthog-node')
}

export function createPostHogClient(writeKey: string, consent: ConsentState): PostHogSdk.PostHog {
  const client = new (loadPostHogSdk().PostHog)(writeKey, {
    host: 'https://us.i.posthog.com',
    flushAt: POSTHOG_FLUSH_AT,
    flushInterval: POSTHOG_FLUSH_INTERVAL_MS,
    // Disable SDK GeoIP/IP enrichment to keep the wire inside the declared allow-list.
    disableGeoip: true,
    // Increase offline buffer from 1000 to 5000; overflow drops oldest events.
    maxQueueSize: 5000,
    // The SDK's default global fetch skips the desktop session's proxy; resolved per send.
    // Omit credentials so the desktop session never attaches its cookies to telemetry.
    fetch: (url, options) => getMainHttpClient().fetch(url, { ...options, credentials: 'omit' })
  })

  if (shouldOptOutSdkAtInit(consent)) {
    client.optOut()
  }
  return client
}
