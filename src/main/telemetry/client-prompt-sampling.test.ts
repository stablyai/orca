import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventProps } from '../../shared/telemetry-events'
import { track } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

const prompt: EventProps<'agent_prompt_sent'> = {
  agent_kind: 'codex',
  launch_source: 'unknown',
  request_kind: 'followup'
}

describe('prompt event sampling', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    vi.useFakeTimers()
    // Milestones already earned, so only the sampled prompt stream is measured here.
    state = setupTelemetryClientTest({
      optedIn: true,
      installId: BASE_COMMON.install_id,
      existedBeforeTelemetryRelease: false,
      protectedMilestones: { firstAgentInteractionDay: 0, meaningfulActivityDay: 1_000_000 }
    })
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
    vi.useRealTimers()
  })

  it('retains 1% of prompts without spending the shared budget on discarded events', () => {
    let draw = 0
    vi.spyOn(Math, 'random').mockImplementation(() => ((draw++ % 100) + 0.5) / 100)
    const settingsReads = vi.mocked(state.store.getSettings).mock.calls.length

    for (let index = 0; index < 1_000; index++) {
      vi.advanceTimersByTime(1_000)
      track('agent_prompt_sent', prompt)
    }

    expect(state.mock.capture).toHaveBeenCalledTimes(10)
    expect(state.store.getSettings).toHaveBeenCalledTimes(settingsReads + 10)
    expect(track('app_opened', {})).toBe(true)
    for (const [message] of state.mock.capture.mock.calls.slice(0, 10)) {
      expect(message.properties).toMatchObject({ ...prompt, sample_rate: 0.01 })
    }
  })

  it('uses the same sampling boundary for hooks and renderer prompt sources', () => {
    const random = vi.spyOn(Math, 'random')
    for (const launch_source of ['unknown', 'sidebar', 'diff_notes_send'] as const) {
      random.mockReturnValue(0.01)
      expect(track('agent_prompt_sent', { ...prompt, launch_source })).toBe(false)
      random.mockReturnValue(0.0099)
      expect(track('agent_prompt_sent', { ...prompt, launch_source })).toBe(true)
    }

    expect(state.mock.capture).toHaveBeenCalledTimes(3)
    for (const [message] of state.mock.capture.mock.calls) {
      expect(message.properties.sample_rate).toBe(0.01)
      expect(message.properties.$process_person_profile).toBe(false)
    }
  })

  it('does not sample workflow starts or failures', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    expect(track('agent_prompt_sent', prompt)).toBe(false)
    expect(track('agent_started', prompt)).toBe(true)
    expect(track('agent_error', { agent_kind: 'codex', error_class: 'unknown' })).toBe(true)
    expect(state.mock.capture).toHaveBeenCalledTimes(2)
    for (const [message] of state.mock.capture.mock.calls) {
      expect(message.properties).not.toHaveProperty('sample_rate')
    }
  })

  it('still enforces consent and rejects raw prompt text on selected events', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    state.settings.telemetry!.optedIn = false
    expect(track('agent_prompt_sent', prompt)).toBe(false)
    state.settings.telemetry!.optedIn = true
    const invalid = { ...prompt, prompt: 'private text' }
    expect(track('agent_prompt_sent', invalid)).toBe(false)
    expect(state.mock.capture).not.toHaveBeenCalled()
    expect(track('agent_prompt_sent', prompt)).toBe(true)
  })
})
