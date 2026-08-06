import { describe, expect, it } from 'vitest'
import {
  isSetupHookTrusted,
  normalizeSetupHookTrust,
  persistSetupHookTrustApproval,
  trustedOrcaHooksWithSetupApproval,
  wasSetupHookPreviouslyApproved
} from './setup-hook-trust'
import type { PersistedTrustedOrcaHooks } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'

describe('setup hook trust', () => {
  it('trusts a setup script only when the approved hash matches', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { setup: { contentHash: 'hash-1', approvedAt: 1000 } }
    }

    expect(isSetupHookTrusted(trust, 'repo-1', 'hash-1')).toBe(true)
    expect(isSetupHookTrusted(trust, 'repo-1', 'hash-2')).toBe(false)
  })

  it('treats an always-trusted repo as trusted for changed setup scripts', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': { all: { approvedAt: 1000 } }
    }

    expect(isSetupHookTrusted(trust, 'repo-1', 'new-hash')).toBe(true)
  })

  it('preserves unrelated trust entries when approving setup', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': {
        archive: { contentHash: 'archive-hash', approvedAt: 1000 }
      }
    }

    expect(
      trustedOrcaHooksWithSetupApproval({
        trust,
        repoId: 'repo-1',
        contentHash: 'setup-hash',
        alwaysTrust: false,
        approvedAt: 2000
      })
    ).toEqual({
      'repo-1': {
        archive: { contentHash: 'archive-hash', approvedAt: 1000 },
        setup: { contentHash: 'setup-hash', approvedAt: 2000 }
      }
    })
  })

  it('records always-trust without dropping existing script approvals', () => {
    const trust: PersistedTrustedOrcaHooks = {
      'repo-1': {
        setup: { contentHash: 'setup-hash', approvedAt: 1000 }
      }
    }

    expect(
      trustedOrcaHooksWithSetupApproval({
        trust,
        repoId: 'repo-1',
        contentHash: 'ignored-for-all',
        alwaysTrust: true,
        approvedAt: 2000
      })
    ).toEqual({
      'repo-1': {
        setup: { contentHash: 'setup-hash', approvedAt: 1000 },
        all: { approvedAt: 2000 }
      }
    })
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
    expect(isSetupHookTrusted(next, 'repo-1', 'setup-hash')).toBe(true)
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
