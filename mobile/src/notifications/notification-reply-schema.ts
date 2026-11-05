import { z } from 'zod'
import type {
  MobilePushRegisterResult,
  MobilePushTestResult
} from '../../../src/shared/mobile-push-contract'
import { hostUnionArms, salvagedOptional } from '../../../src/shared/zod-salvage'

// Keep notification replies nullish/optional where callers use optional access; tightening them would replace existing fallback copy with incompatible-reply errors.

// No caller inspects these reply bodies; requiring fields would add a contract with no reader.
export const notificationUnreadReplySchema = z.unknown()

// Pin refusal arms to host unions so host additions/removals fail typecheck instead of silently degrading.
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

// Salvage unknown reasons/nonobjects to generic send-failure copy; schema errors here would instead surface the reader’s message.
export const pushDeliveryTestResultSchema = z
  .looseObject({
    accepted: salvagedOptional('accepted', z.boolean()),
    reason: salvagedOptional('reason', z.enum(PUSH_TEST_REFUSAL_REASONS))
  })
  .nullish()
  .catch(undefined)

// Require no fields: registration reads registered through optional access; declared host metadata remains available without rejecting old replies.
export const pushRouteRegistrationSchema = z
  .looseObject({
    registered: salvagedOptional('registered', z.boolean()),
    registrationId: salvagedOptional('registrationId', z.string()),
    reason: salvagedOptional('reason', z.enum(PUSH_REGISTER_REFUSAL_REASONS))
  })
  .nullish()

// Leave dismissal rows unknown for the shared identity validator; hosts omit dismissedPushes unless deliveredPushes was supplied.
export const missedNotificationsSchema = z
  .looseObject({
    dismissedPushes: salvagedOptional('dismissedPushes', z.array(z.unknown()))
  })
  .nullish()
