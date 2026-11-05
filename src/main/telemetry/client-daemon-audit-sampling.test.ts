import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'
import {
  recordAuthenticatedInventory,
  type DaemonAuditContext
} from '../daemon/daemon-audit-classifier'
import { createDaemonAuditEligibilityTracker } from '../daemon/daemon-audit-eligibility-event'
import { track } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'

const context: DaemonAuditContext = {
  protocolGeneration: 23,
  provider: 'local-daemon',
  endpoint: 'private-endpoint',
  tokenPath: 'private-token-path',
  endpointKind: 'unix-socket',
  profileScope: 'private-profile'
}

describe('daemon audit event sampling', () => {
  let state: TelemetryClientTestState

  beforeEach(() => {
    vi.useFakeTimers()
    state = setupTelemetryClientTest()
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
    vi.useRealTimers()
  })

  it('captures one in 1,000 eligible observations without spending the budget on discarded events', () => {
    let draw = 0
    let nowMs = 0
    vi.spyOn(Math, 'random').mockImplementation(() => ((draw++ % 1_000) + 0.5) / 1_000)
    const tracker = createDaemonAuditEligibilityTracker(() => nowMs)
    const settingsReads = vi.mocked(state.store.getSettings).mock.calls.length

    for (let index = 0; index < 1_000; index++) {
      nowMs += 5 * 60_000
      vi.advanceTimersByTime(5 * 60_000)
      tracker(recordAuthenticatedInventory(context, null))
    }

    expect(state.mock.capture).toHaveBeenCalledOnce()
    expect(state.store.getSettings).toHaveBeenCalledTimes(settingsReads + 1)
    const message = state.mock.capture.mock.calls[0][0]
    expect(message.event).toBe('daemon_audit_eligibility')
    expect(message.properties.sample_rate).toBe(0.001)
    expect(message.properties.$process_person_profile).toBe(false)
    const eventProperties = { ...message.properties }
    for (const key of Object.keys(BASE_COMMON)) {
      delete eventProperties[key]
    }
    delete eventProperties.$process_person_profile
    expect(eventSchemas.daemon_audit_eligibility.safeParse(eventProperties).success).toBe(true)
    eventProperties.sample_rate = 0.01
    expect(eventSchemas.daemon_audit_eligibility.safeParse(eventProperties).success).toBe(false)
    expect(track('app_opened', {})).toBe(true)
  })

  it('keeps the five-minute repeat limit even when the previous observation was discarded', () => {
    let nowMs = 0
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.001)
    const tracker = createDaemonAuditEligibilityTracker(() => nowMs)
    const observation = recordAuthenticatedInventory(context, null)

    for (let index = 0; index < 40; index++) {
      tracker(observation)
    }
    expect(random).toHaveBeenCalledOnce()
    expect(state.mock.capture).not.toHaveBeenCalled()

    nowMs = 5 * 60_000
    random.mockReturnValue(0.000999)
    tracker(observation)
    expect(state.mock.capture).toHaveBeenCalledOnce()
  })
})
