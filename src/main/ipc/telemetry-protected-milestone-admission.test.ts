import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence/loading-store/store'

const { handleMock, trackMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  trackMock: vi.fn(() => true)
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: { handle: handleMock }
}))
vi.mock('../telemetry/client', () => ({
  hasTrackedAgentDashboardActiveToday: vi.fn(() => false),
  persistBannerAcknowledgeWithoutEmitting: vi.fn(),
  setOptIn: vi.fn(),
  track: trackMock
}))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../telemetry/onboarding-cohort-classifier', () => ({
  getOnboardingCohortAtEmit: () => ({})
}))

import { registerTelemetryHandlers } from './telemetry'

describe('renderer telemetry admission', () => {
  it('cannot forge protected milestones but still forwards their source events', () => {
    const store: Partial<Store> = {}
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the track handler never reads the store.
    registerTelemetryHandlers(store as Store)
    const [, trackHandler] = handleMock.mock.calls.find(
      ([channel]) => channel === 'telemetry:track'
    )!
    const sender = { sender: {} }

    expect(
      trackHandler(sender, 'first_agent_interaction', {
        source: 'orca_send',
        agent_kind: 'codex',
        install_cohort: 'fresh'
      })
    ).toBe(false)
    expect(
      trackHandler(sender, 'meaningful_activity_day', {
        trigger: 'orca_send',
        install_cohort: 'fresh'
      })
    ).toBe(false)
    expect(
      trackHandler(sender, 'native_chat_prompt_submitted', {
        agent_kind: 'codex',
        runtime: 'local',
        client: 'desktop'
      })
    ).toBe(false)
    expect(trackMock).not.toHaveBeenCalled()

    const send = { agent_kind: 'codex', launch_source: 'sidebar', request_kind: 'followup' }
    expect(trackHandler(sender, 'agent_prompt_sent', send)).toBe(true)
    expect(trackMock).toHaveBeenCalledWith('agent_prompt_sent', send)
  })
})
