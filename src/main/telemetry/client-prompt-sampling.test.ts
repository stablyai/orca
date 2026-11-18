import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventProps } from '../../shared/telemetry/telemetry-event-classification'
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
