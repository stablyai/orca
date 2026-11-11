import { describe, expect, it } from 'vitest'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import type { UnvalidatedRpcRequestPort } from '../transport/rpc/unvalidated-rpc-request-port'
import type { RpcResponse } from '../transport/rpc/rpc-wire-types'

function ok(result: unknown): RpcResponse {
  return { id: 'call', ok: true, result }
}

function clientWith(responses: RpcResponse[]): {
  client: UnvalidatedRpcRequestPort
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    client: {
      sendRequest: async (method: string) => {
        calls.push(method)
        return responses.shift() ?? ok({})
      }
    }
  }
}

describe('resolveMobileBranchCompareBaseRef remote pin', () => {
  it('prefers repo origin/master over a stale local worktree master pin', async () => {
    const { client } = clientWith([
      ok({ worktree: { baseRef: 'master' } }),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: 'origin/master' }] })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/master'
    )
  })

  it('prefers git-resolved origin/master over a bare local worktree pin when the repo has no pin', async () => {
    const { client, calls } = clientWith([
      ok({ worktree: { baseRef: 'master' } }),
      ok({ repos: [{ id: 'repo-1' }] }),
      ok({ defaultBaseRef: 'origin/master' })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/master'
    )
    expect(calls).toEqual(['worktree.show', 'repo.list', 'repo.baseRefDefault'])
  })

  it('keeps the worktree base when mobile git is unavailable', async () => {
    const { client } = clientWith([
      ok({ worktree: { baseRef: 'origin/release' } }),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: null }] }),
      {
        id: 'call',
        ok: false,
        error: { code: 'runtime_error', message: 'git is not available to mobile clients' }
      }
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/release'
    )
  })
})
