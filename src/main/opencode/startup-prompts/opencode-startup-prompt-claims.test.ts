import { describe, expect, it, vi } from 'vitest'
import type { TerminalRunFacts } from '../../runtime/terminal/lifecycle/terminal-run-facts'
import { OpenCodeStartupPromptClaims } from './opencode-startup-prompt-claims'

describe('execution-owned startup prompt claims', () => {
  it('consumes each nonce once and checks owner facts at claim time', () => {
    const claims = new OpenCodeStartupPromptClaims()
    let facts: TerminalRunFacts | null = { freshSpawn: true, firstUserInputAt: null }
    claims.register('first', 'hash', () => facts)
    facts.firstUserInputAt = 1
    expect(claims.claim({ nonce: 'first', digest: 'hash' })).toBe(false)
    facts.firstUserInputAt = null
    expect(claims.claim({ nonce: 'first', digest: 'hash' })).toBe(false)
    claims.register('second', 'hash', () => facts)
    expect(claims.claim({ nonce: 'second', digest: 'hash' })).toBe(true)
    expect(claims.claim({ nonce: 'second', digest: 'hash' })).toBe(false)
    claims.register('missing', 'hash', () => facts)
    facts = null
    expect(claims.claim({ nonce: 'missing', digest: 'hash' })).toBe(false)
  })

  it('keeps pending admission bounded and never recreates canceled or consumed claims', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    claims.register('waiting', 'hash', () => 'pending')
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe('pending')
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe('pending')
    expect(claims.admit('waiting', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(true)
    expect(claims.claim({ nonce: 'waiting', digest: 'hash' })).toBe(true)
    expect(claims.admit('waiting', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.register('canceled', 'hash', () => 'pending')
    claims.cancel('canceled')
    expect(claims.admit('canceled', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.register('expired', 'hash', () => 'pending')
    now = 20000
    expect(claims.claim({ nonce: 'expired', digest: 'hash' })).toBe(false)
    expect(claims.admit('expired', () => ({ freshSpawn: true, firstUserInputAt: null }))).toBe(
      false
    )
    claims.clear()
  })

  it('replays only the same operation while execution facts remain authorized', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    let facts: TerminalRunFacts | null = { freshSpawn: true, firstUserInputAt: null }
    const cleanup = vi.fn()
    claims.register('retry', 'hash', () => facts, cleanup)
    const body = { nonce: 'retry', digest: 'hash', requestId: 'stable-operation' }
    expect(claims.claim(body)).toBe(true)
    expect(claims.claim(body)).toBe(true)
    expect(claims.claim({ ...body, requestId: 'another-operation' })).toBe(false)
    expect(claims.claim({ nonce: 'retry', digest: 'hash' })).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    expect(claims.claim(body)).toBe(true)
    facts.firstUserInputAt = 1
    expect(claims.claim(body)).toBe(false)
    expect(cleanup).toHaveBeenCalledTimes(1)
    facts = { freshSpawn: true, firstUserInputAt: null }
    expect(claims.claim(body)).toBe(false)
    claims.register('expires', 'hash', () => facts, cleanup)
    expect(claims.claim({ ...body, nonce: 'expires' })).toBe(true)
    now = 20000
    expect(claims.claim({ ...body, nonce: 'expires' })).toBe(false)
    expect(cleanup).toHaveBeenCalledTimes(2)
  })
})
