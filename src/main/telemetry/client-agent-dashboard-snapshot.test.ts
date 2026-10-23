import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import { persistBannerAcknowledgeWithoutEmitting, track, trackAppOpenedOnce } from './client'
import {
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

describe('Agent Dashboard app-open snapshot', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    state = setupTelemetryClientTest()
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
  })

  it.each([true, false, undefined])(
    'records the saved setting %s once without requiring a toggle or adding an event',
    (enabled) => {
      state.settings.experimentalAgentDashboardPopout = enabled

      trackAppOpenedOnce()
      trackAppOpenedOnce()

      expect(state.mock.capture).toHaveBeenCalledTimes(1)
      expect(state.mock.capture.mock.calls[0]?.[0]).toMatchObject({
        event: 'app_opened',
        properties: {
          agent_dashboard_enabled: enabled === true,
          $process_person_profile: false
        }
      })
    }
  )

  it('overrides a caller-provided snapshot with main-owned settings', () => {
    state.settings.experimentalAgentDashboardPopout = true

    track('app_opened', { agent_dashboard_enabled: false })

    expect(state.mock.capture.mock.calls[0]?.[0].properties.agent_dashboard_enabled).toBe(true)
  })

  it.each(['opt_out', 'pending_banner', 'do_not_track', 'orca_disabled', 'ci'])(
    'sends no snapshot when consent is blocked by %s',
    (block) => {
      state.settings.experimentalAgentDashboardPopout = true
      if (block === 'opt_out') {
        state.settings.telemetry!.optedIn = false
      } else if (block === 'pending_banner') {
        state.settings.telemetry!.optedIn = null
      } else if (block === 'do_not_track') {
        process.env.DO_NOT_TRACK = '1'
      } else if (block === 'orca_disabled') {
        process.env.ORCA_TELEMETRY_DISABLED = '1'
      } else {
        process.env.CI = '1'
      }

      trackAppOpenedOnce()

      expect(state.mock.capture).not.toHaveBeenCalled()
    }
  )

  it('reads the latest setting when the pending banner is resolved', async () => {
    state.settings.telemetry!.optedIn = null
    state.settings.telemetry!.existedBeforeTelemetryRelease = true
    state.settings.experimentalAgentDashboardPopout = false
    trackAppOpenedOnce()
    expect(state.mock.capture).not.toHaveBeenCalled()

    state.settings.experimentalAgentDashboardPopout = true
    await persistBannerAcknowledgeWithoutEmitting()
    trackAppOpenedOnce()

    expect(state.mock.capture).toHaveBeenCalledTimes(1)
    expect(state.mock.capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'app_opened',
      properties: { agent_dashboard_enabled: true }
    })
  })

  it('keeps the app-open schema compatible with older payloads and rejects non-boolean state', () => {
    expect(eventSchemas.app_opened.safeParse({}).success).toBe(true)
    expect(eventSchemas.app_opened.safeParse({ agent_dashboard_enabled: true }).success).toBe(true)
    expect(eventSchemas.app_opened.safeParse({ agent_dashboard_enabled: 'true' }).success).toBe(
      false
    )
  })
})
