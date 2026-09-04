import { z } from 'zod'
import {
  MOBILE_PUSH_AGENT_STATES,
  MOBILE_PUSH_APNS_ENVIRONMENTS,
  MOBILE_PUSH_PLATFORMS,
  MOBILE_PUSH_SOURCES
} from '../../../../shared/mobile-push-contract'
import { defineStreamingMethod, defineMethod, type RpcAnyMethod } from '../core'

// Why: monotonically increasing per-process counter eliminates the
// Date.now() collision that could fire when two near-simultaneous
// notifications.subscribe calls landed on the same millisecond.
let notificationsSubscriptionSeq = 0

const NotificationUnsubscribeParams = z.object({
  subscriptionId: z
    .unknown()
    .transform((value) => (typeof value === 'string' && value.length > 0 ? value : ''))
    .pipe(z.string().min(1, 'Missing subscriptionId'))
})

// Why: notifications.getMissedSince is the catch-up RPC for mobile reconnect
// (#8129). The client passes the highest seq it has already delivered; the
// runtime returns only notifications dispatched after that seq. Because the
// desktop assigns a monotonic seq to every dispatched notification, the cut is
// exact and idempotent — re-requesting with the same watermark can never
// return an already-delivered event, so reconnects never duplicate local
// pushes (the adversarial-review gate for #8129).
// `epoch` names the counter lifetime lastSeenSeq came from (#8591). The desktop's
// seq restarts at 0 on every launch while the client's watermark is persisted, so
// without it a post-restart watermark silently cuts away everything. Optional: a
// client that predates the field keeps the seq-only cut.
const NotificationGetMissedSinceParams = z.object({
  lastSeenSeq: z.number().int().min(0, 'lastSeenSeq must be a non-negative integer'),
  epoch: z.string().optional()
})

// Why: the phone owns which alerts are worth waking it for; the host stores the
// filter per device and applies it before it ever calls the gateway. Native push
// tokens are long (FCM registration strings), so the bound is generous.
const NotificationPushFilterParams = z.object({
  sources: z.array(z.enum(MOBILE_PUSH_SOURCES)).max(MOBILE_PUSH_SOURCES.length),
  agentStates: z.array(z.enum(MOBILE_PUSH_AGENT_STATES)).max(MOBILE_PUSH_AGENT_STATES.length)
})

const NotificationRegisterPushParams = z
  .object({
    platform: z.enum(MOBILE_PUSH_PLATFORMS),
    token: z.string().min(1).max(4096),
    apnsEnvironment: z.enum(MOBILE_PUSH_APNS_ENVIRONMENTS).optional(),
    filter: NotificationPushFilterParams
  })
  // Why: an APNs token is only routable against the environment it was minted in,
  // so a missing environment must fail loudly rather than default to production.
  .refine((params) => params.platform !== 'ios' || params.apnsEnvironment !== undefined, {
    message: 'apnsEnvironment is required for ios'
  })

// Why: notifications.subscribe streams desktop notification events to mobile
// clients over WebSocket. The mobile client shows a local push notification
// for each event. This avoids requiring Firebase/APNs — the existing
// persistent WebSocket connection doubles as the push channel.
export const NOTIFICATION_METHODS: readonly RpcAnyMethod[] = [
  defineStreamingMethod({
    name: 'notifications.subscribe',
    params: null,
    handler: async (_params, { runtime, connectionId }, emit) => {
      await new Promise<void>((resolve) => {
        const unsubscribe = runtime.onNotificationDispatched((event) => {
          emit(event)
        })

        // Why: scope by per-ws connectionId + per-process counter so
        // concurrent subscribes never collide on the cleanup map.
        const seq = ++notificationsSubscriptionSeq
        const subscriptionId = `notifications-${connectionId ?? 'inproc'}-${seq}`
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            emit({ type: 'end' })
            resolve()
          },
          connectionId
        )

        // Why: the epoch rides the ready frame so a reconnecting client learns the
        // counter lifetime BEFORE it sends its watermark to getMissedSince (#8591).
        emit({ type: 'ready', subscriptionId, epoch: runtime.getMobileNotificationEpoch() })
      })
    }
  }),
  defineMethod({
    name: 'notifications.unsubscribe',
    params: NotificationUnsubscribeParams,
    handler: async (params, { runtime }) => {
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  }),
  defineMethod({
    name: 'notifications.getMissedSince',
    params: NotificationGetMissedSinceParams,
    // Why: returns only notifications with seq > lastSeenSeq. The runtime owns
    // the monotonic seq, so this is the single source of truth for what the
    // client missed while its socket was reaped.
    handler: async (params, { runtime }) => {
      const missed = runtime.getMissedNotificationsSince(params.lastSeenSeq, params.epoch)
      return { notifications: missed, epoch: runtime.getMobileNotificationEpoch() }
    }
  }),
  defineMethod({
    name: 'notifications.registerPush',
    params: NotificationRegisterPushParams,
    // Why: the registration is keyed by the revocable paired device identity, never
    // by anything the caller can assert, so an in-process or CLI caller has no device
    // to register and is refused outright.
    handler: async (params, { runtime, clientKind, pairedDeviceId }) => {
      if (clientKind !== 'mobile' || !pairedDeviceId) {
        return { registered: false, reason: 'not_mobile' }
      }
      return await runtime.registerMobilePushDevice({ deviceId: pairedDeviceId, ...params })
    }
  }),
  defineMethod({
    name: 'notifications.unregisterPush',
    params: null,
    // Deleting the gateway token is durable (outbox), so an offline gateway still
    // reports success to the phone that asked to stop being pushed to.
    handler: async (_params, { runtime, clientKind, pairedDeviceId }) => {
      if (clientKind !== 'mobile' || !pairedDeviceId) {
        return { unregistered: false }
      }
      return await runtime.unregisterMobilePushDevice(pairedDeviceId)
    }
  })
]
