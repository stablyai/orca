import { expect, it } from 'vitest'
import { PushNotificationSchema } from '@orca-cloud/push-contract/send-messages'
import { buildPushDelivery } from './push-delivery-message.js'
import { apnsBody } from '../providers/apns/apns-client.js'
import { fcmMessageBody } from '../providers/fcm/fcm-client.js'

it('carries the exact fenced chat target through both providers and refuses reply actions on non-alerts', () => {
  const replyTarget = { type: 'terminal', terminal: 'terminal-17', expectedIncarnationId: 'process-23' }
  const notification = {
    notificationId: 'notification-1', notificationSeq: 1, notificationEpoch: 'epoch-1',
    source: 'agent-task-complete', agentState: 'finished', title: 'Orca', body: 'Finished',
    worktreeId: 'folder:example', paneKey: 'tab:leaf', category: 'orca.reply', replyTarget
  }
  const parsed = PushNotificationSchema.parse(notification)
  const delivery = buildPushDelivery({
    expiresAt: 1_000, registrationId: 'device-1', hostFingerprint: 'paired-host-key1', notification: parsed
  })
  expect(JSON.parse(apnsBody(delivery))).toMatchObject({
    aps: { category: 'orca.reply' },
    orca: { hostFingerprint: 'paired-host-key1', replyTarget }
  })
  expect(JSON.parse(fcmMessageBody({ delivery, token: 'provider-token', channelId: 'orca-desktop', now: 0 }))).toMatchObject({
    message: { data: { categoryId: 'orca.reply', replyTarget: JSON.stringify(replyTarget), hostFingerprint: 'paired-host-key1' } }
  })
  expect(PushNotificationSchema.safeParse({ ...notification, kind: 'dismiss' }).success).toBe(false)
  expect(PushNotificationSchema.safeParse({ ...notification, replyTarget: undefined }).success).toBe(false)
  expect(PushNotificationSchema.safeParse({ ...notification, replyTarget: { type: 'terminal', terminal: 'terminal-17' } }).success).toBe(false)
})
