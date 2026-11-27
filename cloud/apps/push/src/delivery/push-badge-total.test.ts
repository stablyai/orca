import { afterEach, expect, it } from 'vitest'
import type { CloudDatabase as PushDatabase } from '@orca-cloud/cloud-database/cloud-database'
import type { PushNotification } from '@orca-cloud/push-contract/send-messages'
import { openInMemoryPushDatabase } from '../database/push-database.js'
import { PushDeviceRegistryStore } from '../devices/device-registry-store.js'
import { PushBadgeCountStore } from '../devices/push-badge-count-store.js'
import { apnsBody } from '../providers/apns/apns-client.js'
import { DurablePushStore } from './durable-push-store.js'
import { buildPushDelivery, type PushDelivery } from './push-delivery-message.js'
import { PushDispatcher } from './push-dispatcher.js'
import { sendHostBadge, sendRemovalBadge } from './push-badge-send.js'

let db: PushDatabase | null = null
afterEach(async () => {
  await db?.close()
  db = null
})

const notification = (fields: Partial<PushNotification>): PushNotification => ({
  notificationEpoch: 'epoch',
  notificationSeq: 1,
  source: 'agent-task-complete',
  agentState: null,
  title: 'Orca',
  body: '',
  ...fields
})

it("shows the sum of every paired host's unread count on the phone's icon", async () => {
  db = await openInMemoryPushDatabase()
  const devices = new PushDeviceRegistryStore(db)
  const badges = new PushBadgeCountStore(db)
  const bodies: string[] = []
  const apns = {
    send: async (delivery: PushDelivery) => {
      bodies.push(apnsBody(delivery))
      return { status: 'sent' as const }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher calls only send
  const dispatcher = new PushDispatcher({ devices, badges, apns: apns as never })
  const deps = { devices, badges, deliveryStore: new DurablePushStore(db), dispatcher, now: Date.now }
  const pair = async (hostFingerprint: string): Promise<string> => {
    const row = await devices.upsert({
      hostFingerprint,
      deviceId: 'phone',
      platform: 'ios',
      token: 'phone-token',
      apnsEnvironment: 'production'
    })
    if (!row.ok) {
      throw new Error('registration failed')
    }
    return row.registrationId
  }
  const first = await pair('host-a')
  const second = await pair('host-b')
  const lastBody = () => JSON.parse(bodies.at(-1)!)

  await sendHostBadge(deps, 'host-a', [first], notification({ kind: 'badge', badge: 2 }), 2)
  expect(lastBody()).toEqual({ aps: { badge: 2 } })

  await sendHostBadge(deps, 'host-b', [second], notification({ kind: 'badge', badge: 3 }), 3)
  expect(lastBody()).toEqual({ aps: { badge: 5 } })

  await dispatcher.sendOnce(
    buildPushDelivery({
      expiresAt: Date.now() + 60_000,
      registrationId: second,
      hostFingerprint: 'host-b',
      notification: notification({ title: 'Agent finished', notificationSeq: 2 })
    })
  )
  expect(lastBody().aps).toMatchObject({ alert: { title: 'Agent finished' }, badge: 5 })

  const share = await badges.shareOf(first)
  await devices.deleteOwned('host-a', first)
  await sendRemovalBadge(deps, { registrationId: first, token: 'phone-token' }, share)
  expect(lastBody()).toEqual({ aps: { badge: 3 } })
})
