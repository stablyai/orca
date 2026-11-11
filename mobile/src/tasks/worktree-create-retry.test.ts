import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { markRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'

import { createWorktreeWithNameRetry } from './worktree-create-retry'

type Attempt = { method: string; params: unknown }

function scriptedClient(
  outcomes: ({ id: string; displayName?: string; warning?: string } | { errorMessage: string })[],
  attempts: Attempt[]
): RpcClient {
  let call = 0
  const client = new FakeSession('connected')
  client.sendRequest.mockImplementation(async (method: string, params?: unknown) => {
    attempts.push({ method, params: params ?? {} })
    const outcome = outcomes[Math.min(call, outcomes.length - 1)]!
    call += 1
    if ('errorMessage' in outcome) {
      return {
        id: '1',
        ok: false,
        error: { code: 'x', message: outcome.errorMessage },
        _meta: { runtimeId: 'r' }
      }
    }
    return {
      id: '1',
      ok: true,
      result: {
        worktree: {
          id: outcome.id,
          ...(outcome.displayName !== undefined ? { displayName: outcome.displayName } : {})
        },
        ...(outcome.warning !== undefined ? { warning: outcome.warning } : {})
      },
      _meta: { runtimeId: 'r' }
    }
  })
  return client
}

describe('createWorktreeWithNameRetry parent', () => {
  it('attaches every collision candidate to the same parent', async () => {
    const attempts: Attempt[] = []
    const client = scriptedClient(
      [{ errorMessage: 'already exists locally' }, { id: 'wt-child' }],
      attempts
    )

    await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      parent: { parentWorkspace: 'folder:f-1', parentWorkspaceOrigin: 'manual' },
      worktreeCreateIdempotency: false
    })

    expect(attempts.map((attempt) => attempt.params)).toEqual([
      {
        repo: 'id:r',
        name: 'topic',
        parentWorkspace: 'folder:f-1',
        parentWorkspaceOrigin: 'manual'
      },
      {
        repo: 'id:r',
        name: 'topic-2',
        parentWorkspace: 'folder:f-1',
        parentWorkspaceOrigin: 'manual'
      }
    ])
  })
})

describe('createWorktreeWithNameRetry after a lost reply', () => {
  it('tries no other name when the resend is refused as taken', async () => {
    const client = new FakeSession('connected')
    client.sendRequest
      .mockImplementationOnce(async () => {
        client.publishState('reconnecting')
        setTimeout(() => client.publishState('connected'), 0)
        throw markRpcDeliveryUnknown(new Error('connection lost'))
      })
      .mockResolvedValue({
        id: '1',
        ok: false,
        error: { code: 'x', message: 'already exists locally' },
        _meta: { runtimeId: 'r' }
      })

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: { dedupeTtlMs: 60_000 }
    })

    expect(result).toMatchObject({ replayed: true })
    expect(client.sendRequest.mock.calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ name: 'topic' }),
      expect.objectContaining({ name: 'topic' })
    ])
  })
  it('tries no other name when a fallback create after a refused agent launch is resent and refused', async () => {
    const client = new FakeSession('connected')
    const taken: RpcResponse = {
      id: '1',
      ok: false,
      error: { code: 'x', message: 'already exists locally' },
      _meta: { runtimeId: 'r' }
    }
    client.sendRequest
      .mockResolvedValueOnce({
        id: '1',
        ok: false,
        error: { code: 'method_not_found', message: 'Unknown method' },
        _meta: { runtimeId: 'r' }
      })
      .mockImplementationOnce(async () => {
        client.publishState('reconnecting')
        setTimeout(() => client.publishState('connected'), 0)
        throw markRpcDeliveryUnknown(new Error('connection lost'))
      })
      .mockResolvedValue(taken)

    const result = await createWorktreeWithNameRetry({
      client,
      baseName: 'topic',
      buildParams: (name) => ({ repo: 'id:r', name }),
      worktreeCreateIdempotency: { dedupeTtlMs: 60_000 },
      agentLaunch: { agent: 'claude', supported: { replay: false } }
    })

    expect(result).toMatchObject({ replayed: true })
    expect(client.sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'agent.launch',
      'worktree.create',
      'worktree.create'
    ])
    expect(client.sendRequest.mock.calls.slice(1).map(([, params]) => params)).toEqual([
      expect.objectContaining({ name: 'topic' }),
      expect.objectContaining({ name: 'topic' })
    ])
  })
})
