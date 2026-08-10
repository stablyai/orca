import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRuntimeEnvironmentSubscriptionSetup,
  cancelAllRuntimeEnvironmentSubscriptionSetups,
  cancelRuntimeEnvironmentSubscriptionSetup,
  cancelRuntimeEnvironmentSubscriptionSetupsForEnvironment,
  finishRuntimeEnvironmentSubscriptionSetup,
  hasRuntimeEnvironmentSubscriptionSetup
} from './runtime-environment-subscription-setup'

afterEach(() => {
  cancelAllRuntimeEnvironmentSubscriptionSetups()
})

describe('pending runtime environment subscription setup', () => {
  it('aborts a pending setup and releases its subscription id', () => {
    const controller = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'pending-subscription',
      environmentId: 'environment-a',
      ownerWebContentsId: 1
    })

    expect(cancelRuntimeEnvironmentSubscriptionSetup('pending-subscription', 1)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    expect(hasRuntimeEnvironmentSubscriptionSetup('pending-subscription')).toBe(false)
  })

  it('isolates cancellation by sender', () => {
    const controller = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'owned-subscription',
      environmentId: 'environment-a',
      ownerWebContentsId: 1
    })

    expect(cancelRuntimeEnvironmentSubscriptionSetup('owned-subscription', 2)).toBe(false)
    expect(controller.signal.aborted).toBe(false)
    expect(hasRuntimeEnvironmentSubscriptionSetup('owned-subscription')).toBe(true)
  })

  it('aborts only setups for the invalidated environment', () => {
    const firstController = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'first-subscription',
      environmentId: 'environment-a',
      ownerWebContentsId: 1
    })
    const secondController = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'second-subscription',
      environmentId: 'environment-b',
      ownerWebContentsId: 1
    })

    cancelRuntimeEnvironmentSubscriptionSetupsForEnvironment('environment-a')

    expect(firstController.signal.aborted).toBe(true)
    expect(secondController.signal.aborted).toBe(false)
    expect(hasRuntimeEnvironmentSubscriptionSetup('first-subscription')).toBe(false)
    expect(hasRuntimeEnvironmentSubscriptionSetup('second-subscription')).toBe(true)
  })

  it('keeps a reused id when an earlier setup finishes late', () => {
    const firstController = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'reused-subscription',
      environmentId: 'environment-a',
      ownerWebContentsId: 1
    })
    cancelRuntimeEnvironmentSubscriptionSetup('reused-subscription', 1)
    const replacementController = beginRuntimeEnvironmentSubscriptionSetup({
      subscriptionId: 'reused-subscription',
      environmentId: 'environment-a',
      ownerWebContentsId: 1
    })

    finishRuntimeEnvironmentSubscriptionSetup('reused-subscription', firstController)

    expect(replacementController.signal.aborted).toBe(false)
    expect(hasRuntimeEnvironmentSubscriptionSetup('reused-subscription')).toBe(true)
  })
})
