import { z } from 'zod'
import type {
  MobilePushRegisterResult,
  MobilePushTestResult
} from '../../../src/shared/mobile-push-contract'
import { hostUnionArms, salvagedOptional } from '../../../src/shared/zod-salvage'

// The four notification replies mobile reads: the push-route register/unregister pair, the
// settings screen's delivery probe, and the tray catch-up. Checked against the handlers in
// src/main/runtime/rpc/methods/notifications.ts and the shared MobilePushRegisterResult /
// MobilePushTestResult in src/shared/mobile-push-contract.ts.
//
// Every one of them is nullish-tolerant at the top level, and that is a property of the call
// sites rather than a concession: all four read the payload through `?.`, so main reached the
// screen with `undefined` there and showed its own copy instead of throwing. Requiring an object
// would turn each of those into an `RpcIncompatibleReplyError` the call site has no place to show.

/**
 * The reply body no call site reads.
 *
 * The stream unsubscribe is sent by the disposer under `.catch(() => {})`, and the unregister is
 * decided by its acceptance alone (push-registration.ts:124 reads `accepted` and nothing else).
 * Declaring a member on either would be a requirement with no reader behind it.
 */
export const notificationUnreadReplySchema = z.unknown()

// Both reason vocabularies are pinned to the host's own refusal arms through hostUnionArms, so an
// arm added or dropped host-side fails tsc here instead of degrading silently on the phone.
export const PUSH_TEST_REFUSAL_REASONS = hostUnionArms<
  Extract<MobilePushTestResult, { accepted: false }>['reason']
>({
  not_registered: true,
  unavailable: true,
  rate_limited: true,
  rejected: true
})
export const PUSH_REGISTER_REFUSAL_REASONS = hostUnionArms<
  Extract<MobilePushRegisterResult, { registered: false }>['reason']
>({
  gateway_unreachable: true,
  gateway_rejected: true,
  not_mobile: true,
  registration_storage_failed: true,
  throttled: true
})

/**
 * Whether Orca's push service took a test notification.
 *
 * Both members are optional and both are read through `?.`:
 * notification-display-test.tsx:51 tests `result?.accepted` and :55/:60 branch on `result?.reason`.
 * `reason` is a closed enum because those two comparisons are the whole of what it decides — an arm
 * this build does not know degrades to the generic "Could not send" copy, which is the arm main took
 * for every unrecognised string too — pinned by the `notifications-display-test-unknown-reason`
 * golden. The arms are the host's own (mobile-push-contract.ts:99), pinned to it above.
 *
 * Total, so a result that is not an object degrades the same way. A refusal here would not be
 * silent: the call site's `try` turns it into the reader's own sentence in the message slot where
 * main printed "Could not send through Orca's push service", which is a different screen for a
 * reply main tolerated.
 */
export const pushDeliveryTestResultSchema = z
  .looseObject({
    accepted: salvagedOptional('accepted', z.boolean()),
    reason: salvagedOptional('reason', z.enum(PUSH_TEST_REFUSAL_REASONS))
  })
  .nullish()
  .catch(undefined)

/**
 * Whether the host committed this device's push route.
 *
 * `registered` is the only member read — push-registration.ts:117 compares it to `true` through
 * `?.` on a payload main already typed as nullable — so the reply stays nullish and every member
 * optional. `registrationId` and `reason` are declared because the host sends them
 * (MobilePushRegisterResult, mobile-push-contract.ts:38-49, whose five reason arms these are,
 * pinned to it above) and a future reader should find them here rather than re-assert them.
 */
export const pushRouteRegistrationSchema = z
  .looseObject({
    registered: salvagedOptional('registered', z.boolean()),
    registrationId: salvagedOptional('registrationId', z.string()),
    reason: salvagedOptional('reason', z.enum(PUSH_REGISTER_REFUSAL_REASONS))
  })
  .nullish()

/**
 * Which of this device's delivered pushes the host has already dismissed elsewhere.
 *
 * The rows stay `z.unknown()`: push-dismissal-reconciliation.ts:66 iterates them and :70 hands each
 * one to `readPushNotificationIdentity`, which is the identity validator both delivery routes
 * share, and narrowing the element here would drop a row that function still accepts.
 * `dismissedPushes` is optional because the host omits it unless the caller sent `deliveredPushes`
 * (src/main/runtime/rpc/methods/notifications.ts:70), and the call site's `Array.isArray` guard is
 * what main relied on.
 */
export const missedNotificationsSchema = z
  .looseObject({
    dismissedPushes: salvagedOptional('dismissedPushes', z.array(z.unknown()))
  })
  .nullish()
