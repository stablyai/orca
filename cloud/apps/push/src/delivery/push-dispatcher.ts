import type { ApnsClient } from '../providers/apns/apns-client.js'
import type { PushDeviceRegistryStore } from '../devices/device-registry-store.js'
import type { PushBadgeCountStore } from '../devices/push-badge-count-store.js'
import type { FcmClient } from '../providers/fcm/fcm-client.js'
import { fingerprintLogPrefix } from '../host-auth/host-fingerprint.js'
import type { PushDelivery } from './push-delivery-message.js'
import type { PushProviderOutcome } from '../providers/push-provider-outcome.js'

export type PushDispatcherOptions = {
  devices: PushDeviceRegistryStore
  badges: PushBadgeCountStore
  apns?: ApnsClient
  fcm?: FcmClient
  onOutcome?: (outcome: PushProviderOutcome['status']) => void
}

// Retires the registration when the provider says the token is gone.
export class PushDispatcher {
  constructor(private readonly options: PushDispatcherOptions) {}

  async sendOnce(queued: PushDelivery): Promise<PushProviderOutcome> {
    const device = await this.options.devices.findById(queued.registrationId)
    if (!device || device.dead) return { status: 'dead', reason: 'registration_unavailable' }
    let delivery = queued
    // Android launchers count the notifications they show; there is no icon number to set.
    if (queued.orca.kind === 'badge' && device.platform !== 'ios') {
      return { status: 'sent' }
    }
    if (device.platform === 'ios' && queued.orca.kind !== 'dismiss') {
      // Summed at send time, so a queued push never carries a total another host has since moved.
      const badge = await this.options.badges.total(device.token)
      if (badge !== null) {
        delivery = { ...queued, badge }
      }
    }
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
      await this.options.devices.markDead(device)
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
    return outcome
  }
}
