import { describe, expect, it, vi } from 'vitest'
import type { TerminalRunFacts } from '../runtime/terminal-run-facts'
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

  it('refuses reattachment, mismatched hashes, expired claims and malformed bodies', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    claims.register('reattach', 'hash', () => ({ freshSpawn: false, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'reattach', digest: 'hash' })).toBe(false)
    claims.register('mismatch', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'mismatch', digest: 'other' })).toBe(false)
    expect(claims.claim({ nonce: 'mismatch', digest: 'hash' })).toBe(false)
    claims.register('expired', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    now = 20000
    expect(claims.claim({ nonce: 'expired', digest: 'hash' })).toBe(false)
    for (const body of [null, 1, {}, { nonce: 1 }, { nonce: 'absent' }]) {
      expect(claims.claim(body)).toBe(false)
    }
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

  it('bounds pending claims and reclaims expired capacity without timers', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    for (let index = 0; index < 129; index++) {
      claims.register(String(index), 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    }
    expect(claims.claim({ nonce: '128', digest: 'hash' })).toBe(false)
    now = 20000
    claims.register('new', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'new', digest: 'hash' })).toBe(true)
  })
  it('starts a fresh bounded claim window after delayed spawn admission', () => {
    vi.useFakeTimers()
    try {
      const claims = new OpenCodeStartupPromptClaims()
      claims.register('slow-spawn', 'hash', () => 'pending')
      vi.advanceTimersByTime(18000)
      const cleanup = vi.fn()
      expect(
        claims.admit('slow-spawn', () => ({ freshSpawn: true, firstUserInputAt: null }), cleanup)
      ).toBe(true)
      vi.advanceTimersByTime(8000)
      expect(claims.claim({ nonce: 'slow-spawn', digest: 'hash' })).toBe(true)
      expect(cleanup).toHaveBeenCalledTimes(1)
      claims.clear()
    } finally {
      vi.useRealTimers()
    }
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

  it('does not renew admission, retain unbounded IDs or replay retired owners', () => {
    let now = 0
    const claims = new OpenCodeStartupPromptClaims(() => now)
    let facts: TerminalRunFacts | null = { freshSpawn: true, firstUserInputAt: null }
    claims.register('bound', 'hash', () => 'pending')
    now = 18000
    expect(claims.admit('bound', () => facts)).toBe(true)
    now = 37000
    expect(claims.admit('bound', () => facts)).toBe(false)
    expect(claims.claim({ nonce: 'bound', digest: 'hash', requestId: 'x'.repeat(129) })).toBe(false)
    expect(claims.claim({ nonce: 'bound', digest: 'hash', requestId: 'operation' })).toBe(true)
    facts = null
    expect(claims.claim({ nonce: 'bound', digest: 'hash', requestId: 'operation' })).toBe(false)
    claims.register('clear', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
    expect(claims.claim({ nonce: 'clear', digest: 'hash', requestId: 'operation' })).toBe(true)
    claims.clear()
    expect(claims.claim({ nonce: 'clear', digest: 'hash', requestId: 'operation' })).toBe(false)
  })

  it.each([null, 1, '', 'with spaces', 'x'.repeat(129)])(
    'rejects malformed operation ID %j without consuming valid authorization',
    (requestId) => {
      const claims = new OpenCodeStartupPromptClaims()
      claims.register('valid', 'hash', () => ({ freshSpawn: true, firstUserInputAt: null }))
      expect(claims.claim({ nonce: 'valid', digest: 'hash', requestId })).toBe(false)
      expect(claims.claim({ nonce: 'valid', digest: 'hash', requestId: 'valid-operation' })).toBe(
        true
      )
      claims.clear()
    }
  )

  it('expires the renewed window without permitting repeated admission to extend it', () => {
    vi.useFakeTimers()
    try {
      const claims = new OpenCodeStartupPromptClaims()
      claims.register('bounded', 'hash', () => 'pending')
      vi.advanceTimersByTime(18000)
      const owner = () => ({ freshSpawn: true, firstUserInputAt: null })
      const cleanup = vi.fn()
      expect(claims.admit('bounded', owner, cleanup)).toBe(true)
      expect(claims.claim({ nonce: 'bounded', digest: 'hash', requestId: 'operation' })).toBe(true)
      vi.advanceTimersByTime(19999)
      expect(claims.admit('bounded', owner)).toBe(false)
      expect(claims.claim({ nonce: 'bounded', digest: 'hash', requestId: 'operation' })).toBe(true)
      vi.advanceTimersByTime(1)
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(claims.claim({ nonce: 'bounded', digest: 'hash', requestId: 'operation' })).toBe(false)
      claims.clear()
    } finally {
      vi.useRealTimers()
    }
  })
})
