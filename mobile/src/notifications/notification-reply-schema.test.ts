import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  missedNotificationsSchema,
  notificationUnreadReplySchema,
  PUSH_REGISTER_REFUSAL_REASONS,
  PUSH_TEST_REFUSAL_REASONS,
  pushDeliveryTestResultSchema,
  pushRouteRegistrationSchema
} from './notification-reply-schema'

function reads<T>(schema: z.ZodType<T, unknown>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`expected a readable reply: ${parsed.error.message}`)
  }
  return parsed.data
}

function refuses(schema: z.ZodType<unknown, unknown>, value: unknown): boolean {
  return !schema.safeParse(value).success
}

describe('notification replies tolerate the shapes their call sites guard', () => {
  it('reads a test-push reply the screen reaches through optional chaining', () => {
    expect(reads(pushDeliveryTestResultSchema, { accepted: true })?.accepted).toBe(true)
    expect(reads(pushDeliveryTestResultSchema, null)).toBe(null)
    expect(reads(pushDeliveryTestResultSchema, undefined)).toBe(undefined)
    expect(reads(pushDeliveryTestResultSchema, { error: 'refused' })?.accepted).toBe(undefined)
  })

  // The screen interprets this inside a `try` that prints the thrown message, so a refusal would
  // replace main's "Could not send through Orca's push service" with the reader's own sentence.
  it('reads a non-object test-push result as absent, which takes the generic copy', () => {
    for (const value of ['garbage', 7, true, []]) {
      expect(refuses(pushDeliveryTestResultSchema, value)).toBe(false)
      const result = reads(pushDeliveryTestResultSchema, value)
      expect(result?.accepted).toBe(undefined)
      expect(result?.reason).toBe(undefined)
    }
  })

  it('reads a registration reply the reconciler reaches through optional chaining', () => {
    expect(reads(pushRouteRegistrationSchema, { registered: true })?.registered).toBe(true)
    expect(reads(pushRouteRegistrationSchema, null)).toBe(null)
    expect(reads(pushRouteRegistrationSchema, { registered: 'yes' })?.registered).toBe(undefined)
  })

  it('takes every reply at the two sites whose body nothing reads', () => {
    expect(refuses(notificationUnreadReplySchema, undefined)).toBe(false)
    expect(refuses(notificationUnreadReplySchema, null)).toBe(false)
    expect(refuses(notificationUnreadReplySchema, 'anything')).toBe(false)
  })
})

describe('closed enums degrade to the copy main showed', () => {
  it('keeps a reason the screen branches on and drops one it does not know', () => {
    expect(
      reads(pushDeliveryTestResultSchema, { accepted: false, reason: 'rate_limited' })?.reason
    ).toBe('rate_limited')
    expect(
      reads(pushDeliveryTestResultSchema, { accepted: false, reason: 'not_registered' })?.reason
    ).toBe('not_registered')
    // An arm this build has never seen falls to the generic "could not send" copy, which is the
    // arm main took for it too.
    expect(reads(pushDeliveryTestResultSchema, { accepted: false, reason: 'quota' })?.reason).toBe(
      undefined
    )
  })

  it('keeps a registration reason and drops an unknown one', () => {
    const reply = { registered: false, reason: 'throttled' }
    expect(reads(pushRouteRegistrationSchema, reply)?.reason).toBe('throttled')
    expect(
      reads(pushRouteRegistrationSchema, { registered: false, reason: 'moon-phase' })?.reason
    ).toBe(undefined)
  })

  // Both arm lists are pinned to the host's refusal unions in the schema module, where tsc looks;
  // these loops prove every pinned arm survives the parse, not just the ones picked above.
  it('keeps every refusal reason the host declares for either route', () => {
    for (const reason of PUSH_TEST_REFUSAL_REASONS) {
      expect(reads(pushDeliveryTestResultSchema, { accepted: false, reason })?.reason).toBe(reason)
    }
    for (const reason of PUSH_REGISTER_REFUSAL_REASONS) {
      expect(reads(pushRouteRegistrationSchema, { registered: false, reason })?.reason).toBe(reason)
    }
  })
})

describe('dismissal rows stay opaque', () => {
  it('keeps every row for readPushNotificationIdentity to judge', () => {
    const rows = [{ notificationId: 'n-1' }, 'not-a-row', 7]
    expect(reads(missedNotificationsSchema, { dismissedPushes: rows })?.dismissedPushes).toEqual(
      rows
    )
  })

  it('drops a dismissedPushes that is not an array, as Array.isArray did', () => {
    expect(reads(missedNotificationsSchema, { dismissedPushes: 'all' })?.dismissedPushes).toBe(
      undefined
    )
    expect(reads(missedNotificationsSchema, null)).toBe(null)
  })
})
