import { PUSH_LIMITS } from '@orca-cloud/push-contract/push-limits'
import type { PushNotification, PushSendResult } from '@orca-cloud/push-contract/send-messages'
import type { PushDeviceRegistryStore } from '../devices/device-registry-store.js'
import type { PushBadgeCountStore } from '../devices/push-badge-count-store.js'
import type { DurablePushStore } from './durable-push-store.js'
import type { PushDispatcher } from './push-dispatcher.js'
import { buildPushDelivery } from './push-delivery-message.js'

type BadgeSendDeps = {
  devices: PushDeviceRegistryStore
  badges: PushBadgeCountStore
  deliveryStore: DurablePushStore
  dispatcher: PushDispatcher
  now: () => number
}

// Sent now, not queued: the total is read at send time, so the host's next update is the retry,
// and a gateway revision that predates badges never claims one and sends it as a blank alert.
export async function sendBadge(
  deps: BadgeSendDeps,
  registrationId: string,
  hostFingerprint: string,
  notification: PushNotification
): Promise<PushSendResult['status']> {
  const outcome = await deps.dispatcher.sendOnce(
    buildPushDelivery({
      expiresAt: deps.now() + PUSH_LIMITS.notificationTtlSeconds * 1000,
      registrationId,
      hostFingerprint,
      notification
    })
  )
  return outcome.status === 'sent' ? 'queued' : outcome.status
}

/** Records the host's count for each of its registrations and pushes each phone its new total. */
export async function sendHostBadge(
  deps: BadgeSendDeps,
  hostFingerprint: string,
  registrationIds: readonly string[],
  notification: PushNotification,
  badge: number
): Promise<PushSendResult[]> {
  const owned = await deps.devices.findOwned(hostFingerprint, registrationIds)
  const live = [...owned.values()].some((device) => !device.dead)
  const admitted = live && (await deps.deliveryStore.admitBadge(hostFingerprint))
  return await Promise.all(
    registrationIds.map(async (registrationId): Promise<PushSendResult> => {
      const device = owned.get(registrationId)
      if (!device || device.dead) {
        return { registrationId, status: device ? 'dead' : 'error' }
      }
      // Recorded even when throttled: the phone's next alert carries the total.
      await deps.badges.record(registrationId, badge)
      if (!admitted) return { registrationId, status: 'rate_limited' }
      return {
        registrationId,
        status: await sendBadge(deps, registrationId, hostFingerprint, notification)
      }
    })
  )
}

/** After a removal, the phone's icon still holds that host's share until it gets the new total. */
export async function sendRemovalBadge(
  deps: BadgeSendDeps,
  removed: { registrationId: string; token: string },
  share: number
): Promise<void> {
  if (share === 0) return
  const carrier = await deps.badges.carrier(removed.token)
  if (!carrier) return
  await sendBadge(deps, carrier.registrationId, carrier.hostFingerprint, {
    kind: 'badge',
    notificationEpoch: `removed:${removed.registrationId}`,
    notificationSeq: 0,
    source: 'agent-task-complete',
    agentState: null,
    title: 'Orca',
    body: ''
  })
}
