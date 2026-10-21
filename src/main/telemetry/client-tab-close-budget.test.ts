import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventProps } from '../../shared/telemetry-events'
import {
  _setCommonPropsForTests,
  initTelemetry,
  setOptIn,
  track,
  trackAppOpenedOnce
} from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

const left: EventProps<'tabs_directional_close_requested'> = {
  direction: 'left',
  tab_type: 'terminal',
  surface: 'workspace',
  eligible_tab_count: 3
}
const right: EventProps<'tabs_directional_close_requested'> = { ...left, direction: 'right' }

describe('directional tab close event budget', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    state = setupTelemetryClientTest()
    _setCommonPropsForTests({
      ...BASE_COMMON,
      install_id: '00000000-0000-4000-8000-000000000013'
    })
  })
  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
    vi.useRealTimers()
  })

  it('captures at most two events across tab types, surfaces, and token-bucket refills', () => {
    vi.useFakeTimers()
    expect(track('tabs_directional_close_requested', left)).toBe(true)
    expect(track('tabs_directional_close_requested', right)).toBe(true)

    for (let index = 0; index < 100; index++) {
      vi.advanceTimersByTime(60_000)
      expect(
        track('tabs_directional_close_requested', {
          ...left,
          tab_type: 'browser',
          surface: 'floating'
        })
      ).toBe(false)
      expect(track('tabs_directional_close_requested', right)).toBe(false)
    }

    expect(state.mock.capture).toHaveBeenCalledTimes(2)
  })

  it('does not let repeat clicks exhaust the other direction or the global event budget', () => {
    track('tabs_directional_close_requested', left)
    for (let index = 0; index < 1500; index++) {
      track('tabs_directional_close_requested', left)
    }

    expect(track('tabs_directional_close_requested', right)).toBe(true)
    expect(track('app_opened', {})).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(3)
  })

  it('allows each direction again after a new app session starts', () => {
    track('tabs_directional_close_requested', left)
    track('tabs_directional_close_requested', right)
    initTelemetry(state.store)

    expect(track('tabs_directional_close_requested', left)).toBe(true)
    expect(track('tabs_directional_close_requested', right)).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(4)
  })

  it('does not spend the direction allowance while telemetry is disabled', () => {
    state.settings.telemetry!.optedIn = false
    expect(track('tabs_directional_close_requested', left)).toBe(false)
    state.settings.telemetry!.optedIn = true

    expect(track('tabs_directional_close_requested', left)).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(1)
  })

  it('does not spend the direction allowance on an invalid payload', () => {
    expect(track('tabs_directional_close_requested', { ...left, eligible_tab_count: -1 })).toBe(
      false
    )

    expect(track('tabs_directional_close_requested', left)).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(1)
  })

  it.each([true, false])(
    'includes settings opt-in in the denominator (sampled: %s)',
    async (sampled) => {
      if (!sampled) {
        _setCommonPropsForTests(BASE_COMMON)
      }
      state.settings.telemetry!.optedIn = false
      trackAppOpenedOnce()
      expect(track('tabs_directional_close_requested', left)).toBe(false)
      expect(state.mock.capture).not.toHaveBeenCalled()

      await setOptIn('settings', true)
      expect(track('tabs_directional_close_requested', left)).toBe(sampled)
      await setOptIn('settings', false)
      await setOptIn('settings', true)
      trackAppOpenedOnce()
      expect(track('tabs_directional_close_requested', left)).toBe(false)

      const captures = state.mock.capture.mock.calls.map(([capture]) => capture)
      const opened = captures.filter((capture) => capture.event === 'app_opened')
      expect(opened).toHaveLength(1)
      expect(opened[0].properties).toMatchObject({
        tab_close_sampled: sampled,
        tab_close_sample_rate: 0.1,
        session_id: BASE_COMMON.session_id
      })
      expect(captures[0]).toEqual(opened[0])
      const closes = captures.filter(
        (capture) => capture.event === 'tabs_directional_close_requested'
      )
      expect(closes).toHaveLength(sampled ? 1 : 0)
      if (sampled) {
        expect(closes[0].properties.session_id).toBe(opened[0].properties.session_id)
      }
    }
  )

  it('does not consume the denominator while an environment consent override blocks opt-in', async () => {
    process.env.DO_NOT_TRACK = '1'
    await setOptIn('settings', true)
    expect(track('tabs_directional_close_requested', left)).toBe(false)
    expect(state.mock.capture).not.toHaveBeenCalled()

    delete process.env.DO_NOT_TRACK
    await setOptIn('settings', true)
    expect(track('tabs_directional_close_requested', left)).toBe(true)
    expect(state.mock.capture.mock.calls.map(([capture]) => capture.event)).toEqual([
      'app_opened',
      'telemetry_opted_in',
      'tabs_directional_close_requested'
    ])
  })

  it('marks sampled installs on the existing app-open event without adding an event', () => {
    track('app_opened', { tab_close_sampled: false })
    track('tabs_directional_close_requested', left)

    expect(state.mock.capture).toHaveBeenCalledTimes(2)
    expect(state.mock.capture.mock.calls[0]?.[0].properties).toMatchObject({
      tab_close_sampled: true,
      tab_close_sample_rate: 0.1
    })
    expect(state.mock.capture.mock.calls[1]?.[0].properties).toMatchObject({ sample_rate: 0.1 })
  })

  it('excludes unsampled installs while leaving other analytics enabled', () => {
    _setCommonPropsForTests(BASE_COMMON)

    for (let index = 0; index < 1500; index++) {
      expect(track('tabs_directional_close_requested', left)).toBe(false)
      expect(track('tabs_directional_close_requested', right)).toBe(false)
    }
    expect(track('app_opened', { tab_close_sampled: true })).toBe(true)
    expect(
      track('workspace_created', { source: 'command_palette', from_existing_branch: false })
    ).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(2)
    expect(state.mock.capture.mock.calls[0]?.[0].properties).toMatchObject({
      tab_close_sampled: false,
      tab_close_sample_rate: 0.1
    })
  })
})
