import { describe, expect, it } from 'vitest'
import { isSetupHookTrusted } from './setup-hook-trust'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'

describe('setup hook trust', () => {
  it('trusts a setup script only when the approved hash matches', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { setup: { contentHash: 'hash-1', approvedAt: 1000 } }
    }

    expect(isSetupHookTrusted(trust, [{ id: 'repo-1' }], 'repo-1', 'hash-1')).toBe(true)
    expect(isSetupHookTrusted(trust, [{ id: 'repo-1' }], 'repo-1', 'hash-2')).toBe(false)
  })
})
