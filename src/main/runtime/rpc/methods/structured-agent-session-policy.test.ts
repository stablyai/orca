import { describe, expect, it } from 'vitest'
import {
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import {
  createSupportFollowsHostSetting,
  supportsStructuredAgentSessions
} from './structured-agent-session-policy'

const CAPABLE = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

describe('supportsStructuredAgentSessions', () => {
  it.each(['runtime', 'mobile'] as const)(
    'admits a %s client that advertises the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: CAPABLE })).toBe(
        true
      )
    }
  )

  it('admits a capability-less in-process caller, which negotiates nothing', () => {
    expect(
      supportsStructuredAgentSessions({ clientKind: undefined, clientCapabilities: undefined })
    ).toBe(true)
  })

  it.each(['runtime', 'mobile'] as const)(
    'refuses a %s client that did not advertise the capability',
    (clientKind) => {
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: [] })).toBe(false)
      expect(supportsStructuredAgentSessions({ clientKind, clientCapabilities: undefined })).toBe(
        false
      )
    }
  )
})

describe('createSupportFollowsHostSetting', () => {
  it.each(['runtime', 'mobile'] as const)(
    'leaves a %s client that picks its own launch mode to capability alone',
    (clientKind) => {
      expect(
        createSupportFollowsHostSetting({
          clientKind,
          clientCapabilities: [...CAPABLE, STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY]
        })
      ).toBe(false)
    }
  )

  it.each(['runtime', 'mobile'] as const)(
    'answers a %s client that leaves the mode to the host with the host setting',
    (clientKind) => {
      expect(createSupportFollowsHostSetting({ clientKind, clientCapabilities: CAPABLE })).toBe(
        true
      )
    }
  )

  it('leaves an in-process caller, the same build as the host, to capability alone', () => {
    expect(
      createSupportFollowsHostSetting({ clientKind: undefined, clientCapabilities: undefined })
    ).toBe(false)
  })
})
