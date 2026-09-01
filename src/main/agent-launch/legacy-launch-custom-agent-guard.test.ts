import { describe, expect, it } from 'vitest'
import { shouldRejectLegacyCustomAgentLaunch } from './legacy-launch-custom-agent-guard'

const CUSTOM_ID = 'custom-agent:claude:11111111-1111-4111-8111-111111111111'

describe('shouldRejectLegacyCustomAgentLaunch (U7 legacy built-in path)', () => {
  it('rejects a remote client naming a custom id with no agentLaunch', () => {
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: false,
        requestClientKind: 'mobile',
        requestedAgentId: CUSTOM_ID
      })
    ).toBe(true)
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: false,
        requestClientKind: 'runtime',
        requestedAgentId: CUSTOM_ID
      })
    ).toBe(true)
  })

  it('allows a remote client naming a BUILT-IN id on the legacy path', () => {
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: false,
        requestClientKind: 'mobile',
        requestedAgentId: 'claude'
      })
    ).toBe(false)
  })

  it('never rejects a trusted in-process caller (undefined clientKind) even with a custom id', () => {
    // Headless automation and desktop pass no authenticated clientKind and keep the
    // legacy path with their custom automation.agentId.
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: false,
        requestClientKind: undefined,
        requestedAgentId: CUSTOM_ID
      })
    ).toBe(false)
  })

  it('never rejects when a host-atomic agentLaunch drives the launch (custom id is host-resolved)', () => {
    // A custom createdWithAgent alongside agentLaunch is legitimate attribution.
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: true,
        requestClientKind: 'mobile',
        requestedAgentId: CUSTOM_ID
      })
    ).toBe(false)
  })

  it('does not reject when no agent id is present', () => {
    expect(
      shouldRejectLegacyCustomAgentLaunch({
        hasAgentLaunch: false,
        requestClientKind: 'mobile',
        requestedAgentId: undefined
      })
    ).toBe(false)
  })
})
