import { describe, expect, it } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { createHookStatusSessionTabsInvalidator } from './hook-status-session-tabs-invalidation'

function working(
  overrides: Partial<AgentHookEventPayload> = {},
  payload: Partial<ParsedAgentStatusPayload> = {}
): AgentHookEventPayload {
  return {
    paneKey: 'tab:leaf',
    connectionId: null,
    payload: { state: 'working', prompt: 'fix the tests', agentType: 'claude', ...payload },
    ...overrides
  }
}

describe('createHookStatusSessionTabsInvalidator', () => {
  it('invalidates the first time a pane reports', () => {
    const changed = createHookStatusSessionTabsInvalidator()

    expect(changed(working())).toBe(true)
  })

  it('stays quiet while the same status keeps being pinged', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working())

    expect(changed(working())).toBe(false)
  })

  it('invalidates when a restored row is confirmed by live activity', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working({ restoredUnconfirmed: true }))

    expect(changed(working())).toBe(true)
  })

  it.each([
    ['state', { state: 'waiting' as const }],
    ['workingMode', { workingMode: 'monitoring' as const }],
    ['prompt', { prompt: 'ship it' }],
    ['agentType', { agentType: 'codex' }],
    ['toolName', { toolName: 'Bash' }],
    ['interactivePrompt', { interactivePrompt: '{"questions":[]}' }],
    ['interrupted', { interrupted: true }]
  ])('invalidates when %s changes', (_field, payload) => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working())

    expect(changed(working({}, payload))).toBe(true)
  })

  it('invalidates when the completion stamp is added, changed, or removed', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working())

    expect(changed(working({}, { turnCompletedAt: 100 }))).toBe(true)
    expect(changed(working({}, { turnCompletedAt: 200 }))).toBe(true)
    expect(changed(working())).toBe(true)
  })

  it('invalidates when the assistant body changes', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working({}, { lastAssistantMessage: 'First answer' }))

    expect(changed(working({}, { lastAssistantMessage: 'Corrected answer' }))).toBe(true)
  })

  it('ignores resume-identity rows, which the provider-session path owns', () => {
    const changed = createHookStatusSessionTabsInvalidator()

    expect(changed(working({ providerSessionOnly: true }))).toBe(false)
  })

  it('tracks panes independently', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working())

    expect(changed(working({ paneKey: 'tab:other' }))).toBe(true)
    expect(changed(working())).toBe(false)
  })

  it('re-arms a forgotten pane so an identical relaunch still invalidates', () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working())
    changed.forgetPane('tab:leaf')

    expect(changed(working())).toBe(true)
  })

  it("names an SSH host's panes so a disconnect can republish each of them", () => {
    const changed = createHookStatusSessionTabsInvalidator()
    changed(working({ connectionId: 'conn-1' }))
    changed(working({ paneKey: 'tab:remote', connectionId: 'conn-1' }))
    changed(working({ paneKey: 'tab:local' }))

    expect(changed.forgetConnection('conn-1').sort()).toEqual(['tab:leaf', 'tab:remote'])
    expect(changed(working({ paneKey: 'tab:local' }))).toBe(false)
  })
})
