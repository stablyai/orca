import { afterEach, beforeEach, describe, expect, it, type vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'
import { track, trackAppOpenedOnce } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type MockPostHog,
  type TelemetryClientTestState
} from './client-test-harness'

describe('track()', () => {
  let state: TelemetryClientTestState
  let mock: MockPostHog
  let store: Store

  beforeEach(() => {
    state = setupTelemetryClientTest()
    mock = state.mock
    store = state.store
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
  })

  // Burst-cap before consent reads settings so opted-out renderer floods cannot burn consent-resolution CPU.
  it('burst cap runs BEFORE consent resolve', () => {
    ;(store.getSettings as ReturnType<typeof vi.fn>).mockReturnValue({
      telemetry: {
        optedIn: false,
        installId: BASE_COMMON.install_id,
        existedBeforeTelemetryRelease: false
      }
    })
    for (let i = 0; i < 30; i++) {
      track('app_opened', {})
    }
    const callsAtBoundary = (store.getSettings as ReturnType<typeof vi.fn>).mock.calls.length
    for (let i = 0; i < 20; i++) {
      track('app_opened', {})
    }
    expect((store.getSettings as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsAtBoundary)
    expect(mock.capture).not.toHaveBeenCalled()
  })

  it('drops invalid events before calling capture', () => {
    track('agent_error', {
      error_class: 'unknown',
      agent_kind: 'claude-code',
      error_message: 'leaked message'
    } as never)
    expect(mock.capture).not.toHaveBeenCalled()
  })

  it('trackAppOpenedOnce emits app_opened at most once per session', () => {
    trackAppOpenedOnce()
    trackAppOpenedOnce()
    expect(mock.capture).toHaveBeenCalledTimes(1)
    expect(mock.capture.mock.calls[0]![0].event).toBe('app_opened')
  })
})
