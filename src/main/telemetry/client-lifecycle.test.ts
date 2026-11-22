import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { persistBannerAcknowledgeWithoutEmitting, setOptIn } from './client'
import {
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

  it('keeps the SDK opted out and sends no consent events while DO_NOT_TRACK overrides', async () => {
    process.env.DO_NOT_TRACK = '1'

    await setOptIn('settings', true)
    await persistBannerAcknowledgeWithoutEmitting()
    await setOptIn('settings', false)

    expect(mock.optIn).not.toHaveBeenCalled()
    expect(mock.capture).not.toHaveBeenCalled()
  })
})
