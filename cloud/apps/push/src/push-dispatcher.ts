import type { ApnsClient } from './apns-client.js'
import type { PushDeviceRegistryStore } from './device-registry-store.js'
import type { FcmClient } from './fcm-client.js'
import { fingerprintLogPrefix } from './host-fingerprint.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from './push-provider-outcome.js'

export type PushDispatcherOptions = {
  devices: PushDeviceRegistryStore
  apns?: ApnsClient
  fcm?: FcmClient
  onOutcome?: (outcome: PushProviderOutcome['status']) => void
}

// Sends one coalesced delivery through the provider the registration belongs
// to, and retires the registration when the provider says the token is gone.
export class PushDispatcher {
  constructor(private readonly options: PushDispatcherOptions) {}

  async deliver(delivery: PushDelivery): Promise<void> {
    const device = await this.options.devices.findById(delivery.registrationId)
    if (!device || device.dead) return
    let outcome: PushProviderOutcome
    if (device.platform === 'ios') {
      outcome = this.options.apns
        ? await this.options.apns.send(delivery, {
            token: device.token,
            apnsEnvironment: device.apnsEnvironment ?? 'production'
          })
        : { status: 'error', reason: 'apns_not_configured' }
    } else {
      outcome = this.options.fcm
        ? await this.options.fcm.send(delivery, { token: device.token })
        : { status: 'error', reason: 'fcm_not_configured' }
    }
    this.options.onOutcome?.(outcome.status)
    if (outcome.status === 'dead') {
      await this.options.devices.markDead(delivery.registrationId)
    }
    if (outcome.status !== 'sent') {
      console.warn(
        JSON.stringify({
          event: 'orca_push_delivery_failed',
          platform: device.platform,
          status: outcome.status,
          reason: outcome.reason,
          host: fingerprintLogPrefix(delivery.hostFingerprint)
        })
      )
    }
  }
}
