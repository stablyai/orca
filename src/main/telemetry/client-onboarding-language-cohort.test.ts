import { afterEach, describe, expect, it, vi } from 'vitest'
import { initTelemetry, track } from './client'
import { cleanupTelemetryClientTest, setupTelemetryClientTest } from './client-test-harness'

const { capture } = vi.hoisted(() => {
  vi.stubGlobal('ORCA_BUILD_IDENTITY', 'stable')
  vi.stubGlobal('ORCA_POSTHOG_WRITE_KEY', 'test-key')
  return { capture: vi.fn() }
})

vi.mock('posthog-node', () => ({
  PostHog: class {
    capture = capture
  }
}))

afterEach(() => capture.mockClear())

describe('onboarding language cohort on analytics', () => {
  it.each(['control', 'treatment', undefined] as const)(
    'attaches %s to completion and activation events without changing consent',
    (cohort) => {
      const state = setupTelemetryClientTest({
        optedIn: true,
        installId: 'test-install',
        existedBeforeTelemetryRelease: false,
        ...(cohort ? { onboardingLanguageCohort: cohort } : {})
      })
      try {
        initTelemetry(state.store)
        track('onboarding_completed', { path: 'open_folder', total_duration_ms: 1000 })
        track('activation_checklist_item_completed', {
          item: 'ranFirstAgent',
          time_since_completed_ms: 2000
        })
        expect(capture).toHaveBeenCalledTimes(2)
        for (const [event] of capture.mock.calls) {
          expect(event.properties.onboarding_language_v1).toBe(cohort)
        }
        if (state.settings.telemetry) {
          state.settings.telemetry.optedIn = false
        }
        track('app_opened', {})
        expect(capture).toHaveBeenCalledTimes(2)
      } finally {
        cleanupTelemetryClientTest(state.envStash)
      }
    }
  )
})
