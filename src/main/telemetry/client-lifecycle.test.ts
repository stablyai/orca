import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistBannerAcknowledgeWithoutEmitting, setOptIn } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
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

  // Capture enqueues asynchronously; opt-out evidence must reach the SDK before optOut discards it.
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

  it('fires app_opened and telemetry_opted_in after the SDK enables settings opt-in', async () => {
    state.settings.telemetry!.optedIn = false
    const order: string[] = []
    mock.optIn.mockImplementation(async () => order.push('optIn'))
    mock.capture.mockImplementation((message: { event?: string }) => {
      order.push(`capture:${message.event}`)
    })
    await setOptIn('settings', true)
    expect(order).toEqual(['optIn', 'capture:app_opened', 'capture:telemetry_opted_in'])
    expect(state.store.updateSettings).toHaveBeenCalledWith(
      { telemetry: expect.objectContaining({ optedIn: true }) },
      { notifyListeners: true }
    )
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
    expect(state.store.updateSettings).toHaveBeenCalledWith(
      { telemetry: expect.objectContaining({ optedIn: true }) },
      { notifyListeners: true }
    )
  })
})
