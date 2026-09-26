import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  canCreateStructuredAgentSessions,
  canServeStructuredAgentSessions
} from './structured-agent-session-policy'

function runtimeWithSetting(
  experimentalNativeChat: boolean
): Pick<OrcaRuntimeService, 'getClientSettings'> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only the Chat UI setting.
  return {
    getClientSettings: () => ({ experimentalNativeChat })
  } as unknown as Pick<OrcaRuntimeService, 'getClientSettings'>
}

const CAPABLE = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

/** Every caller shape that reaches the policy: desktop renderer, paired phone, in-process. */
const CALLERS = [
  { name: 'desktop renderer', clientKind: 'runtime' as const, clientCapabilities: CAPABLE },
  { name: 'paired mobile', clientKind: 'mobile' as const, clientCapabilities: CAPABLE },
  { name: 'in-process', clientKind: undefined, clientCapabilities: undefined }
]

describe('canServeStructuredAgentSessions', () => {
  it('serves every capable caller, and asks nothing of the Chat UI setting', () => {
    expect(CALLERS.map((caller) => canServeStructuredAgentSessions(caller))).toEqual([
      true,
      true,
      true
    ])
  })

  it('refuses a remote client that did not advertise the capability', () => {
    for (const clientKind of ['runtime', 'mobile'] as const) {
      expect(canServeStructuredAgentSessions({ clientKind, clientCapabilities: [] })).toBe(false)
      expect(canServeStructuredAgentSessions({ clientKind, clientCapabilities: undefined })).toBe(
        false
      )
    }
  })
})

describe('canCreateStructuredAgentSessions', () => {
  it.each([true, false])('answers every caller alike when Chat UI is %s', (enabled) => {
    const decisions = CALLERS.map((caller) =>
      canCreateStructuredAgentSessions({ ...caller, runtime: runtimeWithSetting(enabled) })
    )

    expect(decisions).toEqual([enabled, enabled, enabled])
  })

  it('still refuses a remote client without the capability when Chat UI is on', () => {
    for (const clientKind of ['runtime', 'mobile'] as const) {
      expect(
        canCreateStructuredAgentSessions({
          clientKind,
          clientCapabilities: [],
          runtime: runtimeWithSetting(true)
        })
      ).toBe(false)
    }
  })

  it('treats an unreadable settings store as off rather than creating', () => {
    expect(
      canCreateStructuredAgentSessions({
        clientKind: 'runtime',
        clientCapabilities: CAPABLE,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the policy reads only getClientSettings, which throws here.
        runtime: {
          getClientSettings: () => {
            throw new Error('settings unavailable')
          }
        } as unknown as Pick<OrcaRuntimeService, 'getClientSettings'>
      })
    ).toBe(false)
  })
})
