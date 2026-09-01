import { describe, expect, it } from 'vitest'

import { isMobileCustomAgentId, parseMobileCustomAgentBase } from './mobile-tui-agents'

describe('mobile custom agent id syntax', () => {
  it('recognizes the custom-agent prefix', () => {
    expect(isMobileCustomAgentId('custom-agent:claude:one')).toBe(true)
    expect(isMobileCustomAgentId('claude')).toBe(false)
    expect(isMobileCustomAgentId('__blank__')).toBe(false)
  })

  it('parses the base harness from a custom id for display', () => {
    expect(parseMobileCustomAgentBase('custom-agent:claude:one')).toBe('claude')
    expect(parseMobileCustomAgentBase('custom-agent:mimo-code:two')).toBe('mimo-code')
  })

  it('returns null for a non-custom id or an unknown base', () => {
    expect(parseMobileCustomAgentBase('claude')).toBeNull()
    // A base this build does not know (e.g. a newer host) must not resolve.
    expect(parseMobileCustomAgentBase('custom-agent:future-agent:one')).toBeNull()
    expect(parseMobileCustomAgentBase('custom-agent:')).toBeNull()
  })
})
