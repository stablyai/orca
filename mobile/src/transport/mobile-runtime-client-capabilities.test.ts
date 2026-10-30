import { AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY } from '../../../src/shared/structured-agent-session-surface-capabilities'
import { describe, expect, it } from 'vitest'
import { parseRuntimeClientCapabilities } from '../../../src/main/runtime/rpc/runtime-client-capabilities'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from './mobile-runtime-client-capabilities'

describe('mobile runtime client capabilities', () => {
  it('promises menu-scoped command requests', () => {
    expect(MOBILE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      AGENT_SESSION_COMMANDS_ON_REQUEST_CAPABILITY
    )
  })
  it('stays inside the bounds the host parses, which fail closed to no capabilities at all', () => {
    expect(parseRuntimeClientCapabilities(MOBILE_RUNTIME_CLIENT_CAPABILITIES)).toEqual(
      MOBILE_RUNTIME_CLIENT_CAPABILITIES
    )
  })

  it('advertises each capability once so duplicates cannot consume the budget', () => {
    expect(new Set(MOBILE_RUNTIME_CLIENT_CAPABILITIES).size).toBe(
      MOBILE_RUNTIME_CLIENT_CAPABILITIES.length
    )
  })
})
