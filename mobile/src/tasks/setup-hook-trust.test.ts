import { describe, expect, it } from 'vitest'
import { isSetupHookTrusted, persistSetupHookTrustApproval } from './setup-hook-trust'
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

  it('keeps the approved hash with Always trust so a repo on two hosts stops prompting', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: persisting only calls sendRequest.
    const client = {
      sendRequest: async () => ({ ok: true, result: null })
    } as unknown as RpcClient
    const repos = [{ id: 'repo-1' }, { id: 'repo-1' }]

    const next = await persistSetupHookTrustApproval({
      client,
      trust: {},
      repoId: 'repo-1',
      contentHash: 'setup-hash',
      alwaysTrust: true
    })

    expect(isSetupHookTrusted(next, repos, 'repo-1', 'setup-hash')).toBe(true)
    expect(isSetupHookTrusted(next, repos, 'repo-1', 'edited-hash')).toBe(false)
  })
})
