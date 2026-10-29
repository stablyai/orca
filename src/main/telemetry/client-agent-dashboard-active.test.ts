import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTelemetry, track } from './client'
import {
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

describe('Agent Dashboard daily visible use', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-22T12:00:00Z'))
    state = setupTelemetryClientTest()
    state.settings.experimentalAgentDashboardPopout = true
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
    vi.useRealTimers()
  })

  it('caps repeated mounts and observations across windows to one event per surface per UTC day', () => {
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
    expect(track('agent_dashboard_active', { surface: 'in_window' })).toBe(true)
    const settingsReads = vi.mocked(state.store.getSettings).mock.calls.length
    for (let index = 0; index < 1500; index++) {
      track('agent_dashboard_active', { surface: 'popout' })
      track('agent_dashboard_active', { surface: 'in_window' })
    }

    expect(state.mock.capture).toHaveBeenCalledTimes(2)
    expect(state.store.updateSettings).toHaveBeenCalledTimes(2)
    expect(state.store.getSettings).toHaveBeenCalledTimes(settingsReads)
    expect(state.settings.telemetry?.agentDashboardActiveDays).toEqual({
      popout: Math.floor(Date.now() / 86_400_000),
      in_window: Math.floor(Date.now() / 86_400_000)
    })
    expect(track('app_opened', {})).toBe(true)
    expect(state.mock.capture.mock.calls[0]?.[0].properties).toMatchObject({
      surface: 'popout',
      $process_person_profile: false
    })
    expect(state.mock.capture.mock.calls[0]?.[0].properties).not.toHaveProperty('day')
  })

  it('counts the next UTC day without a new app session or opening', () => {
    vi.setSystemTime(new Date('2026-10-22T23:59:59Z'))
    track('agent_dashboard_active', { surface: 'popout' })
    vi.setSystemTime(new Date('2026-10-23T00:00:00Z'))

    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(false)
    expect(state.mock.capture).toHaveBeenCalledTimes(2)
  })

  it('preserves the daily limit across restarts without consuming the event budget on repeats', () => {
    track('agent_dashboard_active', { surface: 'popout' })
    initTelemetry(state.store, () => {})
    for (let index = 0; index < 1500; index++) {
      expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(false)
    }

    expect(state.mock.capture).toHaveBeenCalledTimes(1)
    expect(state.store.updateSettings).toHaveBeenCalledTimes(1)
    expect(track('agent_dashboard_active', { surface: 'in_window' })).toBe(true)
    expect(track('app_opened', {})).toBe(true)
  })

  it.each(['opt_out', 'pending_banner', 'do_not_track', 'orca_disabled', 'ci', 'dashboard_off'])(
    'does not send or consume the daily allowance while blocked by %s',
    (block) => {
      if (block === 'opt_out') {
        state.settings.telemetry!.optedIn = false
      } else if (block === 'pending_banner') {
        state.settings.telemetry!.optedIn = null
      } else if (block === 'dashboard_off') {
        state.settings.experimentalAgentDashboardPopout = false
      } else if (block === 'do_not_track') {
        process.env.DO_NOT_TRACK = '1'
      } else if (block === 'orca_disabled') {
        process.env.ORCA_TELEMETRY_DISABLED = '1'
      } else {
        process.env.CI = '1'
      }

      expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(false)
      expect(state.mock.capture).not.toHaveBeenCalled()
      expect(state.store.updateSettings).not.toHaveBeenCalled()

      state.settings.telemetry!.optedIn = true
      state.settings.experimentalAgentDashboardPopout = true
      delete process.env.DO_NOT_TRACK
      delete process.env.ORCA_TELEMETRY_DISABLED
      delete process.env.CI
      expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
    }
  )

  it('does not consume a daily allowance for invalid payloads', () => {
    const invalid = { surface: 'popout', card: 'private' } as const
    expect(track('agent_dashboard_active', invalid)).toBe(false)
    expect(state.store.updateSettings).not.toHaveBeenCalled()
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
  })

  it('keeps the in-memory limit if saving the cursor fails', () => {
    vi.mocked(state.store.updateSettings).mockImplementation(() => {
      throw new Error('disk unavailable')
    })

    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(false)
    expect(state.mock.capture).toHaveBeenCalledTimes(1)
  })

  it('does not consume a daily allowance before the SDK has finished enabling', () => {
    Object.assign(state.mock, { optedOut: true })
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(false)
    expect(state.store.updateSettings).not.toHaveBeenCalled()
    expect(state.mock.capture).not.toHaveBeenCalled()

    Object.assign(state.mock, { optedOut: false })
    expect(track('agent_dashboard_active', { surface: 'popout' })).toBe(true)
  })
})
