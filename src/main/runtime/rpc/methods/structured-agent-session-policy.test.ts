import { describe, expect, it } from 'vitest'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  supportsStructuredAgentSessions,
  supportsWorkItemStartStructuredSessionCreate
} from './structured-agent-session-policy'

function runtimeWithSetting(
  experimentalStructuredNativeChat: boolean,
  workItemStartPromptDelivery: 'draft' | 'submit-after-ready' = 'draft'
): Pick<OrcaRuntimeService, 'getClientSettings'> {
  return {
    getClientSettings: () => ({ experimentalStructuredNativeChat, workItemStartPromptDelivery })
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

  it('does not enable every structured surface from the work item preference', () => {
    const runtime = runtimeWithSetting(false, 'submit-after-ready')
    const decisions = CALLERS.map((caller) =>
      supportsStructuredAgentSessions({
        clientKind: caller.clientKind,
        clientCapabilities: caller.clientCapabilities,
        runtime
      })
    )

    expect(decisions).toEqual([false, false, false])
  })

  it('admits only an authoritative Work Item Start create', () => {
    const runtime = runtimeWithSetting(false, 'submit-after-ready')
    expect(
      supportsWorkItemStartStructuredSessionCreate(
        {
          runtime,
          clientKind: 'runtime',
          clientCapabilities: CAPABLE,
          localDesktopAuthority: true
        },
        'work-item-start'
      )
    ).toBe(true)
    expect(
      supportsWorkItemStartStructuredSessionCreate(
        {
          runtime,
          clientKind: 'runtime',
          clientCapabilities: CAPABLE,
          pairedDeviceId: 'device-web'
        },
        'work-item-start'
      )
    ).toBe(true)
    expect(
      supportsWorkItemStartStructuredSessionCreate(
        {
          runtime,
          clientKind: 'runtime',
          clientCapabilities: CAPABLE
        },
        'work-item-start'
      )
    ).toBe(false)
    expect(
      supportsWorkItemStartStructuredSessionCreate(
        {
          runtime,
          clientKind: 'mobile',
          clientCapabilities: CAPABLE,
          localDesktopAuthority: true
        },
        'work-item-start'
      )
    ).toBe(false)
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

  it('admits desktop launch when the general structured setting is on', () => {
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
