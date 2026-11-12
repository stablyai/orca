import { describe, expect, it } from 'vitest'
import { FakeSession } from '../transport/connection/mobile-endpoint-supervisor-test-fakes'

import type { RpcResponse } from '../transport/rpc/rpc-wire-types'
import { markRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'

import { createWorktreeWithNameRetry } from './worktree-create-retry'

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
