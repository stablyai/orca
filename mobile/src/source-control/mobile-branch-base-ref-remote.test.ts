import { describe, expect, it } from 'vitest'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

function ok(result: unknown): RpcResponse {
  return { id: 'call', ok: true, result }
}

function clientWith(responses: RpcResponse[]): UnvalidatedRpcRequestPort {
  return {
    sendRequest: async () => responses.shift() ?? ok({})
  }
}

describe('resolveMobileBranchCompareBaseRef remote pin', () => {
  it('prefers repo origin/master over a stale local worktree master pin', async () => {
    const client = clientWith([
      ok({ worktree: { baseRef: 'master' } }),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: 'origin/master' }] })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/master'
    )
  })
})
