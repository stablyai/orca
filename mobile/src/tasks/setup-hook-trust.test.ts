import { describe, expect, it } from 'vitest'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  persistSetupHookTrustApproval,
  wasSetupHookPreviouslyApproved
} from './setup-hook-trust'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/orca-yaml-hook-types'
import type { RpcClient } from '../transport/rpc-client'

describe('setup hook trust', () => {
  it('trusts a setup script only when the approved hash matches', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { setup: { contentHash: 'hash-1', approvedAt: 1000 } }
    }

    expect(isSetupHookTrusted(trust, [{ id: 'repo-1' }], 'repo-1', 'hash-1')).toBe(true)
    expect(isSetupHookTrusted(trust, [{ id: 'repo-1' }], 'repo-1', 'hash-2')).toBe(false)
  })

  it('treats an always-trusted repo as trusted for changed setup scripts', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { all: { approvedAt: 1000 } }
    }

    expect(isSetupHookTrusted(trust, [{ id: 'repo-1' }], 'repo-1', 'new-hash')).toBe(true)
  })

  it('persists and returns the approved trust state', async () => {
    let persisted: unknown
    const client = {
      sendRequest: async (_method: string, params: unknown) => {
        persisted = params
        return { ok: true, result: null }
      }
    } as unknown as RpcClient

    const next = await persistSetupHookTrustApproval({
      client,
      trust: {},
      repoId: 'repo-1',
      contentHash: 'setup-hash',
      alwaysTrust: false
    })

    expect(persisted).toEqual({ trustedOrcaHooks: next })
    expect(isSetupHookTrusted(next, [{ id: 'repo-1' }], 'repo-1', 'setup-hash')).toBe(true)
  })

  it('detects previous setup approval and ignores incomplete trust payloads', () => {
    expect(
      wasSetupHookPreviouslyApproved(
        { 'repo-1': { setup: { contentHash: 'hash-1', approvedAt: 1000 } } },
        'repo-1'
      )
    ).toBe(true)
    expect(normalizeSetupHookTrust({ contentHash: 'hash-1', scriptContent: '' })).toBe(null)
    expect(
      normalizeSetupHookTrust({ contentHash: 'hash-1', scriptContent: 'pnpm install' })
    ).toEqual({
      contentHash: 'hash-1',
      scriptContent: 'pnpm install'
    })
  })
})
