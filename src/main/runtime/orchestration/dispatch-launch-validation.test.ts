// W-T1 (§U9, U6 ledger #1/#16): resolve-only dispatch launch validation. A
// dispatch identity is re-validated against the LIVE catalog with NO safe-fallback
// — a disabled/deleted agent hard-fails the dispatch (the coordinator turns
// ok:false into failDispatch with zero PTY). These pin the failure taxonomy.
import { describe, expect, it } from 'vitest'
import { validateDispatchIdentityAgainstCatalog } from './dispatch-launch-validation'

const CUSTOM_CODEX_ID = 'custom-agent:codex:01234567-89ab-4cde-8f01-23456789abcd'
const LIVE_CUSTOM = {
  id: CUSTOM_CODEX_ID,
  baseAgent: 'codex',
  label: 'My Codex',
  args: '',
  env: {},
  syncEnv: false
}
const DETERMINISTIC = { mintFailureId: () => 'fail-x', now: () => 42 }

describe('validateDispatchIdentityAgainstCatalog', () => {
  it('accepts an enabled built-in agent', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: 'claude', baseAgent: 'claude' },
      {},
      DETERMINISTIC
    )
    expect(result).toEqual({ ok: true })
  })

  it('accepts an enabled live custom agent', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: CUSTOM_CODEX_ID, baseAgent: 'codex' },
      { customTuiAgents: [LIVE_CUSTOM] },
      DETERMINISTIC
    )
    expect(result).toEqual({ ok: true })
  })

  it('hard-fails a disabled built-in as base_agent_disabled', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: 'claude', baseAgent: 'claude' },
      { disabledTuiAgents: ['claude'] },
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure.code).toBe('base_agent_disabled')
  })

  it('hard-fails a custom agent whose base is disabled as base_agent_disabled', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: CUSTOM_CODEX_ID, baseAgent: 'codex' },
      { customTuiAgents: [LIVE_CUSTOM], disabledTuiAgents: ['codex'] },
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure.code).toBe('base_agent_disabled')
  })

  it('hard-fails a disabled custom agent as custom_agent_disabled (no safe-fallback)', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: CUSTOM_CODEX_ID, baseAgent: 'codex' },
      { customTuiAgents: [LIVE_CUSTOM], disabledTuiAgents: [CUSTOM_CODEX_ID] },
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure.code).toBe('custom_agent_disabled')
  })

  it('hard-fails a deleted/unknown requested agent as unknown_agent', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: 'ghost-agent', baseAgent: 'claude' },
      {},
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure.code).toBe('unknown_agent')
  })

  it('stamps the orchestration failure envelope from the injected deps', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: 'ghost-agent', baseAgent: 'claude' },
      {},
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure).toMatchObject({
      code: 'unknown_agent',
      version: 1,
      failureId: 'fail-x',
      intent: 'orchestration',
      occurredAt: 42
    })
    expect(result.error).toContain('ghost-agent')
  })

  it('does not throw and reports unknown when settings are absent', () => {
    const result = validateDispatchIdentityAgainstCatalog(
      { requestedAgent: CUSTOM_CODEX_ID, baseAgent: 'codex' },
      undefined,
      DETERMINISTIC
    )
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.launchFailure.code).toBe('unknown_agent')
  })
})
