import { describe, expect, it } from 'vitest'
import {
  REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES,
  REMOTE_RUNTIME_MAX_SUBSCRIPTIONS
} from '../../shared/remote-runtime-memory-limits'
import { createRuntimeEnvironmentSubscriptionAdmission } from './runtime-environment-subscription-admission'

describe('runtime environment subscription admission', () => {
  it('caps pending and active subscriptions, then recovers after release', () => {
    const admission = createRuntimeEnvironmentSubscriptionAdmission()
    const releases = Array.from({ length: REMOTE_RUNTIME_MAX_SUBSCRIPTIONS }, (_value, index) =>
      admission.claim(`subscription-${index}`, undefined)
    )

    expect(admission.evidence()).toEqual({
      retainedBytes: 0,
      subscriptionCount: REMOTE_RUNTIME_MAX_SUBSCRIPTIONS
    })
    expect(() => admission.claim('overflow', undefined)).toThrow('subscription limit reached')

    releases[0]?.()
    expect(() => admission.claim('recovered', undefined)).not.toThrow()
  })

  it('caps aggregate retained params and releases the claim exactly once', () => {
    const admission = createRuntimeEnvironmentSubscriptionAdmission()
    const exactParams = 'x'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES - 2)
    const claimCount =
      REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES / REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES
    const releases = Array.from({ length: claimCount }, (_value, index) =>
      admission.claim(`large-${index}`, exactParams)
    )

    expect(admission.evidence()).toEqual({
      retainedBytes: REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES,
      subscriptionCount: claimCount
    })
    expect(() => admission.claim('aggregate-overflow', null)).toThrow(
      'subscription memory limit reached'
    )

    releases[0]?.()
    releases[0]?.()
    const recovered = admission.claim('aggregate-recovered', exactParams)
    expect(admission.evidence().retainedBytes).toBe(REMOTE_RUNTIME_MAX_RETAINED_SUBSCRIPTION_BYTES)
    recovered()
  })

  it('bounds caller-supplied ids by UTF-8 bytes and reserves duplicates', () => {
    const admission = createRuntimeEnvironmentSubscriptionAdmission()
    const exactId = 'é'.repeat(REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES / 2)
    const release = admission.claim(exactId, undefined)

    expect(() => admission.claim(exactId, undefined)).toThrow('already exists')
    expect(() => admission.claim(`${exactId}x`, undefined)).toThrow(
      `between 1 and ${REMOTE_RUNTIME_MAX_SUBSCRIPTION_ID_BYTES} bytes`
    )

    release()
    expect(() => admission.claim(exactId, undefined)).not.toThrow()
  })
})
