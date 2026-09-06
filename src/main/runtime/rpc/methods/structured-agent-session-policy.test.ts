import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { supportsStructuredAgentSessions } from './structured-agent-session-policy'

function runtimeWithSetting(
  experimentalStructuredNativeChat: boolean
): Pick<OrcaRuntimeService, 'getClientSettings'> {
  return {
    getClientSettings: () => ({ experimentalStructuredNativeChat })
  } as unknown as Pick<OrcaRuntimeService, 'getClientSettings'>
}

const CAPABLE = [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]

/** Every caller shape that reaches the policy: desktop renderer, paired phone, in-process. */
const CALLERS = [
  { name: 'desktop renderer', clientKind: 'runtime' as const, clientCapabilities: CAPABLE },
  { name: 'paired mobile', clientKind: 'mobile' as const, clientCapabilities: CAPABLE },
  { name: 'in-process', clientKind: undefined, clientCapabilities: undefined }
]

describe('supportsStructuredAgentSessions', () => {
  it.each([true, false])('admits every caller alike when the setting is %s', (enabled) => {
    const decisions = CALLERS.map((caller) =>
      supportsStructuredAgentSessions({
        clientKind: caller.clientKind,
        clientCapabilities: caller.clientCapabilities,
        runtime: runtimeWithSetting(enabled)
      })
    )

    expect(decisions).toEqual([enabled, enabled, enabled])
  })

  it('admits a capability-less in-process caller, which negotiates nothing', () => {
    expect(
      supportsStructuredAgentSessions({
        clientKind: undefined,
        clientCapabilities: undefined,
        runtime: runtimeWithSetting(true)
      })
    ).toBe(true)
  })

  it('still refuses a remote client that did not advertise the capability', () => {
    for (const clientKind of ['runtime', 'mobile'] as const) {
      expect(
        supportsStructuredAgentSessions({
          clientKind,
          clientCapabilities: [],
          runtime: runtimeWithSetting(true)
        })
      ).toBe(false)
    }
  })

  it('leaves desktop launch admission unchanged, because launches require the setting anyway', () => {
    // `agent-launch-routing.ts` refuses to route a structured launch unless
    // `experimentalStructuredNativeChat` is on, so the only state a desktop launch can
    // reach the host in is setting-on — which admits exactly as it did before.
    expect(
      supportsStructuredAgentSessions({
        clientKind: 'runtime',
        clientCapabilities: CAPABLE,
        runtime: runtimeWithSetting(true)
      })
    ).toBe(true)
  })

  it('reads the setting from the caller-supplied value when no runtime is available', () => {
    expect(
      supportsStructuredAgentSessions({
        clientKind: 'runtime',
        clientCapabilities: CAPABLE,
        structuredNativeChatEnabled: true
      })
    ).toBe(true)
    expect(
      supportsStructuredAgentSessions({
        clientKind: 'runtime',
        clientCapabilities: CAPABLE,
        structuredNativeChatEnabled: false
      })
    ).toBe(false)
  })

  it('treats an unreadable settings store as off rather than admitting', () => {
    expect(
      supportsStructuredAgentSessions({
        clientKind: 'runtime',
        clientCapabilities: CAPABLE,
        runtime: {
          getClientSettings: () => {
            throw new Error('settings unavailable')
          }
        } as unknown as Pick<OrcaRuntimeService, 'getClientSettings'>
      })
    ).toBe(false)
  })
})
