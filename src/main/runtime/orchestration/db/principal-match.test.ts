import { describe, expect, it } from 'vitest'
import { isEquivalentPrincipal } from './principal-match'

describe('principal-match', () => {
  const leaf = '11111111-1111-4111-8111-111111111111'

  it('treats pane principals with the same leaf as equivalent across a tab-half remint', () => {
    expect(isEquivalentPrincipal(`pane:tab-a:${leaf}`, `pane:tab-a:${leaf}`)).toBe(true)
    expect(isEquivalentPrincipal(`pane:tab-a:${leaf}`, `pane:tab-b:${leaf}`)).toBe(true)
    expect(
      isEquivalentPrincipal(`pane:tab-a:${leaf}`, 'pane:tab-a:22222222-2222-4222-8222-222222222222')
    ).toBe(false)
  })

  it('matches session principals exactly and only exactly', () => {
    expect(isEquivalentPrincipal('session:s-1', 'session:s-1')).toBe(true)
    expect(isEquivalentPrincipal('session:s-1', 'session:s-2')).toBe(false)
  })

  it('requires an exact match for unparseable values', () => {
    expect(isEquivalentPrincipal('legacy-value', 'legacy-value')).toBe(true)
    expect(isEquivalentPrincipal('legacy-value', 'other-value')).toBe(false)
    expect(isEquivalentPrincipal('unknown:payload', 'unknown:payload')).toBe(true)
    expect(isEquivalentPrincipal('unknown:payload', 'unknown:other')).toBe(false)
  })

  it('NEVER bridges pane and session principals, in either direction', () => {
    // The invariant, not an edge case: a structured pane key's tab half embeds the session id in
    // plain text, so a caller who learns a session id can fabricate this pane key. Only the
    // random leaf is a credential; matching it to the session principal would hand the attacker
    // the coordinator's Run binding.
    const realSessionId = 'session-alpha-1'
    const fabricated = `pane:structured-agent-session-${realSessionId}:${leaf}`
    expect(isEquivalentPrincipal(fabricated, `session:${realSessionId}`)).toBe(false)
    expect(isEquivalentPrincipal(`session:${realSessionId}`, fabricated)).toBe(false)
  })
})
