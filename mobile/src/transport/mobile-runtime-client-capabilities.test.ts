import { describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { MOBILE_RUNTIME_CLIENT_CAPABILITIES } from './mobile-runtime-client-capabilities'

/** Mirrors the host's `parseRuntimeClientCapabilities`, which returns an EMPTY list — silently
 *  dropping every capability, not just the excess — when the array is longer than this or any
 *  entry is longer than 128 chars. Growing past it would look exactly like an old client. */
const HOST_CAPABILITY_LIMIT = 64
const HOST_CAPABILITY_NAME_LIMIT = 128

describe('mobile runtime client capabilities', () => {
  it('advertises structured agent sessions including the Claude lane', () => {
    expect(MOBILE_RUNTIME_CLIENT_CAPABILITIES).toEqual(
      expect.arrayContaining([
        STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY,
        STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
        CLAUDE_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
      ])
    )
  })

  it('stays inside the bounds the host parses, which fail closed to no capabilities at all', () => {
    expect(MOBILE_RUNTIME_CLIENT_CAPABILITIES.length).toBeLessThanOrEqual(HOST_CAPABILITY_LIMIT)
    for (const capability of MOBILE_RUNTIME_CLIENT_CAPABILITIES) {
      expect(capability.length).toBeGreaterThan(0)
      expect(capability.length).toBeLessThanOrEqual(HOST_CAPABILITY_NAME_LIMIT)
    }
  })

  it('advertises each capability once so duplicates cannot consume the budget', () => {
    expect(new Set(MOBILE_RUNTIME_CLIENT_CAPABILITIES).size).toBe(
      MOBILE_RUNTIME_CLIENT_CAPABILITIES.length
    )
  })
})
