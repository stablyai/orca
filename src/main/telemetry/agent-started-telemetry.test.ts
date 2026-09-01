import { describe, expect, it } from 'vitest'
import { buildAgentStartedAttribution } from './agent-started-telemetry'

describe('buildAgentStartedAttribution (oracle 17)', () => {
  const surface = { launch_source: 'sidebar', request_kind: 'new' } as const

  it('carries a host-derived custom marker through with the base kind', () => {
    const attribution = buildAgentStartedAttribution({
      ...surface,
      agent_kind: 'codex',
      used_custom_agent: true
    })
    expect(attribution).toEqual({
      agent_kind: 'codex',
      launch_source: 'sidebar',
      request_kind: 'new',
      used_custom_agent: true
    })
  })

  it('treats an absent used_custom_agent as not custom (built-in / legacy)', () => {
    const attribution = buildAgentStartedAttribution({ ...surface, agent_kind: 'claude-code' })
    expect(attribution?.used_custom_agent).toBe(false)
  })

  it('treats a non-boolean used_custom_agent as not custom (only === true wins)', () => {
    const attribution = buildAgentStartedAttribution({
      ...surface,
      agent_kind: 'claude-code',
      used_custom_agent: 'true'
    })
    expect(attribution?.used_custom_agent).toBe(false)
  })

  it('drops the event when a surface field is missing', () => {
    expect(
      buildAgentStartedAttribution({ agent_kind: 'codex', request_kind: 'new' })
    ).toBeNull()
    expect(
      buildAgentStartedAttribution({ agent_kind: 'codex', launch_source: 'sidebar' })
    ).toBeNull()
  })

  it('drops the event for an out-of-enum agent_kind or launch_source', () => {
    expect(
      buildAgentStartedAttribution({ ...surface, agent_kind: 'made-up-kind' })
    ).toBeNull()
    expect(
      buildAgentStartedAttribution({
        agent_kind: 'codex',
        launch_source: 'not-a-source',
        request_kind: 'new'
      })
    ).toBeNull()
  })

  it('drops the event when nothing was threaded', () => {
    expect(buildAgentStartedAttribution(undefined)).toBeNull()
  })
})
