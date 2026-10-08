import { describe, expect, it } from 'vitest'
import { parseAllowStaleBaseFromSpec } from './coordinator-stale-base-flag'

describe('parseAllowStaleBaseFromSpec', () => {
  it('matches canonical form on its own line and strips it', () => {
    const spec = `Do the work
allow-stale-base: true`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).toBe('Do the work\n')
    expect(strippedSpec).not.toContain('allow-stale-base')
  })

  it('matches case-insensitively', () => {
    const spec = `Do the work
Allow-Stale-Base: TRUE`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).not.toMatch(/[Aa]llow-[Ss]tale-[Bb]ase/)
  })

  it('does not match allow-stale-base: false', () => {
    const spec = `Do the work
allow-stale-base: false`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('does not match allow-stale-base: truthy', () => {
    const spec = `Do the work
allow-stale-base: truthy`
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('does not match the flag embedded inside a sentence', () => {
    const spec = 'we allow-stale-base: true sometimes'
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(false)
    expect(strippedSpec).toBe(spec)
  })

  it('handles the flag as the last line with no trailing newline', () => {
    const spec = 'line 1\nallow-stale-base: true'
    const { allowStale, strippedSpec } = parseAllowStaleBaseFromSpec(spec)
    expect(allowStale).toBe(true)
    expect(strippedSpec).toBe('line 1\n')
    expect(strippedSpec.endsWith('allow-stale-base: true')).toBe(false)
  })
})
