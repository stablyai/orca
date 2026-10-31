import { describe, expect, it } from 'vitest'
import { isOrcaGeneratedPrRemoteName } from './worktree-push-target-reconciliation'

describe('isOrcaGeneratedPrRemoteName', () => {
  it('matches Orca-generated names, including disambiguated ones', () => {
    expect(isOrcaGeneratedPrRemoteName('pr-head')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-contributor-orca')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-head-2')).toBe(true)
    expect(isOrcaGeneratedPrRemoteName('pr-contributor-orca-3')).toBe(true)
  })

  it('does not match unrelated remote names', () => {
    expect(isOrcaGeneratedPrRemoteName('origin')).toBe(false)
    expect(isOrcaGeneratedPrRemoteName('upstream')).toBe(false)
    expect(isOrcaGeneratedPrRemoteName('project-remote')).toBe(false)
  })
})
