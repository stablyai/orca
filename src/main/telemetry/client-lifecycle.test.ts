import type { PostHog } from 'posthog-node'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  _enableTransportForTests,
  _setPostHogClientForTests,
  _setShuttingDownForTests,
  persistBannerAcknowledgeWithoutEmitting,
  setOptIn,
  shouldOptOutSdkAtInit,
  shutdownTelemetry
} from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  makeMockPostHog,
  setupTelemetryClientTest,
  type MockPostHog,
  type TelemetryClientTestState
} from './client-test-harness'

describe('setOptIn()', () => {
  let state: TelemetryClientTestState
  let mock: MockPostHog

  beforeEach(() => {
    state = setupTelemetryClientTest()
    mock = state.mock
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
  })

  // Ordering invariant: the opt-out event is the one signal that transmits
  // against the user's new preference. It must reach the SDK queue before
  // posthog.optOut(), otherwise posthog-node drops it at enqueue time.
  it('waits for telemetry_opted_out to enqueue before posthog.optOut()', async () => {
    const order: string[] = []
    mock.capture.mockImplementation((message: { event?: string; uuid?: string }) => {
      order.push('capture called')
      queueMicrotask(() => {
        order.push('sdk enqueue')
        mock.emitForTests('capture', {
          event: message.event,
          uuid: message.uuid
        })
      })
    })
    mock.optOut.mockImplementation(async () => {
      order.push('optOut')
    })
    await setOptIn('settings', false)
    expect(order).toEqual(['capture called', 'sdk enqueue', 'optOut'])
  })

  it('fires telemetry_opted_in after posthog.optIn without app_opened for settings opt-in', async () => {
    state.settings.telemetry!.optedIn = false
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })
    await setOptIn('settings', true)
    expect(order).toEqual(['optIn', 'capture:telemetry_opted_in'])
  })

  it('drops telemetry_opted_in silently in non-official builds', async () => {
    state.settings.telemetry!.optedIn = false
    _setPostHogClientForTests(null)
    _enableTransportForTests(false)

    await setOptIn('settings', true)

    expect(mock.capture).not.toHaveBeenCalled()
    expect(console.debug).not.toHaveBeenCalled()
  })

  it('fires app_opened once after pending-banner opt-in enables the SDK', async () => {
    state.settings.telemetry = {
      optedIn: null,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: true
    }
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })

    await setOptIn('settings', true)

    expect(order).toEqual(['optIn', 'capture:app_opened', 'capture:telemetry_opted_in'])
  })
})

describe('persistBannerAcknowledgeWithoutEmitting()', () => {
  let state: TelemetryClientTestState
  let mock: MockPostHog

  beforeEach(() => {
    state = setupTelemetryClientTest({
      optedIn: null,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: true
    })
    mock = state.mock
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
  })

  it('fires app_opened after re-enabling the SDK and does not emit telemetry_opted_in', async () => {
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })

    await persistBannerAcknowledgeWithoutEmitting()

    expect(order).toEqual(['optIn', 'capture:app_opened'])
    expect(state.settings.telemetry?.optedIn).toBe(true)
  })
})

// Pin the init-time SDK opt-out decision. The bug this prevents: if
// initTelemetry flipped the SDK optedOut flag for pending_banner, the direct
// posthog.capture(telemetry_opted_out) on the Turn-off path would be dropped.
describe('shouldOptOutSdkAtInit()', () => {
  it('opts out the SDK for every disabled-reason', () => {
    for (const reason of ['user_opt_out', 'ci', 'do_not_track', 'orca_disabled'] as const) {
      expect(shouldOptOutSdkAtInit({ effective: 'disabled', reason })).toBe(true)
    }
  })

  it('does NOT opt out the SDK for pending_banner', () => {
    expect(shouldOptOutSdkAtInit({ effective: 'pending_banner' })).toBe(false)
  })

  it('does NOT opt out the SDK for enabled', () => {
    expect(shouldOptOutSdkAtInit({ effective: 'enabled' })).toBe(false)
  })
})

describe('shutdownTelemetry()', () => {
  afterEach(() => {
    _setShuttingDownForTests(false)
    _setPostHogClientForTests(null)
  })

  it('sets the shutdown gate and calls posthog.shutdown(2000)', async () => {
    const mock = makeMockPostHog()
    _setPostHogClientForTests(mock as unknown as PostHog)
    _setShuttingDownForTests(false)
    await shutdownTelemetry()
    expect(mock.shutdown).toHaveBeenCalledWith(2_000)
    _setPostHogClientForTests(null)
  })

  it('is a no-op when no client is initialized', async () => {
    _setPostHogClientForTests(null)
    await expect(shutdownTelemetry()).resolves.toBeUndefined()
  })
})
