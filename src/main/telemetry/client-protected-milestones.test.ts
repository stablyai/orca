import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { EventProps } from '../../shared/telemetry-events'
import { _enableTransportForTests, track } from './client'
import {
  BASE_COMMON,
  cleanupTelemetryClientTest,
  setupTelemetryClientTest,
  type TelemetryClientTestState
} from './client-test-harness'
import { recordMobileChatSend, recordMobileViewOpened } from './mobile-client-telemetry'
import { observeTerminalUserInput } from './protected-milestones'

const hookPrompt: EventProps<'agent_prompt_sent'> = {
  agent_kind: 'claude-code',
  launch_source: 'unknown',
  request_kind: 'followup'
}
const sidebarSend: EventProps<'agent_prompt_sent'> = { ...hookPrompt, launch_source: 'sidebar' }
const sidebarLaunch: EventProps<'agent_started'> = {
  agent_kind: 'codex',
  launch_source: 'sidebar',
  request_kind: 'new'
}

function telemetry(
  protectedMilestones: NonNullable<GlobalSettings['telemetry']>['protectedMilestones'] = {
    installCohort: 'fresh'
  }
): GlobalSettings['telemetry'] {
  return {
    optedIn: true,
    installId: BASE_COMMON.install_id,
    existedBeforeTelemetryRelease: false,
    protectedMilestones
  }
}

describe('protected telemetry milestones', () => {
  let state: TelemetryClientTestState

  type Message = { event: string; properties: Record<string, unknown> }
  let earlier: Message[] = []
  // Thrown captures were never accepted by the SDK queue.
  const accepted = (): Message[] => [
    ...earlier,
    ...state.mock.capture.mock.calls
      .filter((_, index) => state.mock.capture.mock.results[index]?.type !== 'throw')
      .map(([message]): Message => message)
  ]
  const captured = (event: string) => accepted().filter((message) => message.event === event)
  const milestones = () =>
    accepted()
      .map((message) => message.event)
      .filter((event) => event === 'first_agent_interaction' || event === 'meaningful_activity_day')
  const restart = () => {
    const saved = state.settings.telemetry
    earlier = accepted()
    cleanupTelemetryClientTest(state.envStash)
    state = setupTelemetryClientTest(saved)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-08T23:58:00Z'))
    earlier = []
    state = setupTelemetryClientTest(telemetry())
  })

  afterEach(() => {
    cleanupTelemetryClientTest(state.envStash)
    vi.useRealTimers()
  })

  it('emits the first observed interaction once, across restarts, with unsampled props', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    track('agent_prompt_sent', sidebarSend)
    track('agent_prompt_sent', sidebarSend)
    restart()
    track('agent_prompt_sent', sidebarSend)

    const first = captured('first_agent_interaction')
    expect(first).toHaveLength(1)
    expect(first[0].properties).toEqual({
      ...BASE_COMMON,
      source: 'orca_send',
      agent_kind: 'claude-code',
      install_cohort: 'fresh',
      $process_person_profile: false
    })
    expect(state.settings.telemetry?.protectedMilestones).toEqual({
      installCohort: 'fresh',
      firstAgentInteractionDay: 20_765,
      meaningfulActivityDay: 20_765
    })
  })

  it('records one meaningful day per UTC day across midnight and restart', () => {
    track('agent_started', sidebarLaunch)
    track('workspace_created', { source: 'sidebar', from_existing_branch: false })
    vi.setSystemTime(new Date('2026-11-09T00:01:00Z'))
    restart()
    track('workspace_created', { source: 'sidebar', from_existing_branch: false })
    restart()
    track('agent_started', sidebarLaunch)

    expect(captured('meaningful_activity_day').map((m) => m.properties.trigger)).toEqual([
      'agent_started',
      'workspace_created'
    ])
    expect(state.settings.telemetry?.protectedMilestones?.meaningfulActivityDay).toBe(20_766)
  })

  it('keeps milestones when the source prompt is sampled out', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    expect(track('agent_prompt_sent', sidebarSend)).toBe(false)

    expect(captured('agent_prompt_sent')).toHaveLength(0)
    expect(milestones()).toEqual(['first_agent_interaction', 'meaningful_activity_day'])
    expect(captured('meaningful_activity_day')[0].properties).not.toHaveProperty('sample_rate')
  })

  it('is not starved once noisy events exhaust the session budget', () => {
    for (let index = 0; index < 1_000; index++) {
      vi.advanceTimersByTime(3_000)
      track('agent_error', { agent_kind: 'codex', error_class: 'unknown' })
    }
    expect(track('agent_error', { agent_kind: 'codex', error_class: 'unknown' })).toBe(false)

    vi.spyOn(Math, 'random').mockReturnValue(0)
    expect(track('agent_prompt_sent', sidebarSend)).toBe(false)
    expect(milestones()).toEqual(['first_agent_interaction', 'meaningful_activity_day'])
  })

  it('retries a milestone whose capture was not accepted', () => {
    state.mock.capture.mockImplementationOnce(() => {
      throw new Error('queue rejected')
    })
    track('native_chat_prompt_submitted', {
      agent_kind: 'codex',
      runtime: 'local',
      client: 'desktop'
    })
    expect(state.settings.telemetry?.protectedMilestones?.firstAgentInteractionDay).toBeUndefined()

    track('native_chat_prompt_submitted', {
      agent_kind: 'codex',
      runtime: 'local',
      client: 'desktop'
    })
    expect(milestones()).toEqual(['meaningful_activity_day', 'first_agent_interaction'])
    expect(state.settings.telemetry?.protectedMilestones?.firstAgentInteractionDay).toBe(20_765)
  })

  it('does not consume milestones while consent or the build gate blocks transmission', () => {
    state.settings.telemetry!.optedIn = false
    track('agent_started', sidebarLaunch)
    state.settings.telemetry!.optedIn = true
    _enableTransportForTests(false)
    track('agent_started', sidebarLaunch)
    _enableTransportForTests(true)
    expect(milestones()).toEqual([])
    expect(state.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })

    track('agent_started', sidebarLaunch)
    expect(milestones()).toEqual(['meaningful_activity_day'])
  })

  it('ignores invalid source payloads and renderer-unreachable raw fields', () => {
    const rawPrompt = { ...sidebarSend, prompt: 'private text' }
    track('agent_prompt_sent', rawPrompt)
    const rawMilestone = {
      source: 'orca_send',
      agent_kind: 'codex',
      install_cohort: 'fresh',
      prompt: 'private text'
    } as const
    expect(track('first_agent_interaction', rawMilestone)).toBe(false)
    const forged = { trigger: 'app_opened', install_cohort: 'fresh' }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: deliberately forges an out-of-enum trigger to prove runtime schema rejection.
    const launchOnly = forged as EventProps<'meaningful_activity_day'>
    expect(track('meaningful_activity_day', launchOnly)).toBe(false)
    expect(milestones()).toEqual([])
    expect(state.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })
  })

  it('does not mark activity from passive, automated or unattributed observations', () => {
    track('app_opened', {})
    track('agent_started', { ...sidebarLaunch, request_kind: 'resume' })
    track('agent_started', { ...sidebarLaunch, launch_source: 'orchestration' })
    track('agent_started', { ...sidebarLaunch, launch_source: 'cli' })
    track('workspace_created', { source: 'unknown', from_existing_branch: false })
    recordMobileChatSend('mobile', 'claude', { ok: true, replayed: true })
    recordMobileChatSend('runtime', 'claude', { ok: true, replayed: false })
    recordMobileViewOpened(
      { clientKind: 'mobile' },
      {
        surface: 'chat',
        viewKey: 'chat:1',
        agent: () => 'claude'
      }
    )
    expect(milestones()).toEqual([])

    for (const launch_source of ['orchestration', 'cli', 'unknown'] as const) {
      track('agent_prompt_sent', { ...hookPrompt, launch_source })
    }
    expect(milestones()).toEqual(['first_agent_interaction'])
    expect(captured('first_agent_interaction')[0].properties.source).toBe('unattributed_prompt')
  })

  it('keeps commands and unacknowledged PTY sends from consuming chat milestones', () => {
    track('native_chat_message_sent', { agent_kind: 'codex', runtime: 'local', client: 'desktop' })
    recordMobileChatSend('mobile', 'claude', { ok: true, replayed: false })
    expect(milestones()).toEqual([])
    expect(state.settings.telemetry?.protectedMilestones).toEqual({ installCohort: 'fresh' })

    track('native_chat_prompt_submitted', {
      agent_kind: 'codex',
      runtime: 'remote',
      client: 'desktop'
    })
    expect(captured('first_agent_interaction')[0].properties).toMatchObject({
      source: 'native_chat',
      agent_kind: 'codex'
    })
    expect(captured('meaningful_activity_day')[0].properties.trigger).toBe('native_chat')
  })

  it('marks terminal activity once per day across restart and UTC rollover', () => {
    observeTerminalUserInput()
    restart()
    observeTerminalUserInput()
    expect(milestones()).toEqual(['meaningful_activity_day'])

    vi.setSystemTime(new Date('2026-11-09T00:01:00Z'))
    observeTerminalUserInput()
    expect(
      captured('meaningful_activity_day').map((message) => message.properties.trigger)
    ).toEqual(['terminal_input', 'terminal_input'])
    expect(state.settings.telemetry?.protectedMilestones?.meaningfulActivityDay).toBe(20_766)
  })

  it('rate-limits blocked terminal checks within the day and retries immediately after UTC midnight', () => {
    vi.setSystemTime(new Date('2026-11-08T23:59:59Z'))
    state.settings.telemetry!.optedIn = false
    observeTerminalUserInput()
    state.settings.telemetry!.optedIn = true
    observeTerminalUserInput()
    expect(milestones()).toEqual([])
    expect(state.settings.telemetry?.protectedMilestones?.meaningfulActivityDay).toBeUndefined()

    vi.setSystemTime(new Date('2026-11-09T00:00:01Z'))
    observeTerminalUserInput()
    expect(milestones()).toEqual(['meaningful_activity_day'])
    expect(state.settings.telemetry?.protectedMilestones?.meaningfulActivityDay).toBe(20_766)
  })
})
