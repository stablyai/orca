import { describe, expect, it } from 'vitest'
import {
  canonicalizeAgentSessionIdentity,
  createEphemeralAgentSessionClaimSigner
} from './agent-session-claim-identity'

describe('agent session claim identity', () => {
  it('creates stable opaque identity and worktree digests', () => {
    const signer = createEphemeralAgentSessionClaimSigner('profile-1')
    const identity = canonicalizeAgentSessionIdentity('codex', {
      key: 'session_id',
      id: 'session-1'
    })
    const namespace = {
      machine: 'machine',
      principal: 'user',
      container: 'native',
      providerRoot: 'default'
    }

    const first = signer.createClaim({ namespace, identity, canonicalWorktreeId: 'worktree-1' })
    const second = signer.createClaim({ namespace, identity, canonicalWorktreeId: 'worktree-1' })
    const otherWorktree = signer.createClaim({
      namespace,
      identity,
      canonicalWorktreeId: 'worktree-2'
    })

    expect(first).toEqual(second)
    expect(first.identityDigest).not.toContain('session-1')
    expect(otherWorktree.identityDigest).toBe(first.identityDigest)
    expect(otherWorktree.worktreeScopeDigest).not.toBe(first.worktreeScopeDigest)
  })

  it('rejects malformed and unsupported provider identity', () => {
    expect(() =>
      canonicalizeAgentSessionIdentity('codex', { key: 'session_id', id: '-unsafe' })
    ).toThrow('agent_session_identity_required')
    expect(() =>
      canonicalizeAgentSessionIdentity('blank', { key: 'session_id', id: 'session-1' })
    ).toThrow('agent_session_identity_required')
  })
})
