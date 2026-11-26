import { randomUUID } from 'node:crypto'
import type { PostHog } from 'posthog-node'
import type { CommonProps } from '../../shared/telemetry/telemetry-event-classification'
import type { OptInVia } from '../../shared/telemetry/schemas/telemetry-property-schemas'
import { consumeBurstToken } from './burst-cap'
import { waitForCaptureEnqueue } from './posthog-transport'
import { validate } from './validator'

/** Enqueue opt-out directly before disabling the SDK; track would reject it under the newly stored preference. */
export async function captureOptOutBeforeSdkOptOut(
  client: PostHog,
  common: CommonProps,
  via: OptInVia
): Promise<void> {
  if (!consumeBurstToken('telemetry_opted_out')) {
    return
  }
  const validated = validate('telemetry_opted_out', { via })
  if (!validated.ok) {
    return
  }
  const uuid = randomUUID()
  const enqueued = waitForCaptureEnqueue(client, 'telemetry_opted_out', uuid)
  client.capture({
    distinctId: common.install_id,
    event: 'telemetry_opted_out',
    uuid,
    properties: { ...common, ...validated.props, $process_person_profile: false }
  })
  if (!(await enqueued)) {
    console.warn('[telemetry] telemetry_opted_out did not enqueue before SDK opt-out')
  }
}
