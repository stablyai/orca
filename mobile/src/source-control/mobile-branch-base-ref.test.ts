import { describe, expect, it } from 'vitest'
import { resolveMobileBranchCompareBaseRef } from './mobile-branch-base-ref'
import type { RpcClient } from '../transport/rpc-client'

type RpcResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } }

function ok(result: unknown): RpcResponse {
  return { ok: true, result }
}

function fail(message: string): RpcResponse {
  return { ok: false, error: { code: 'runtime_error', message } }
}

function clientWith(responses: RpcResponse[]) {
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  return {
    calls,
    client: {
      sendRequest: async (method: string, params?: Record<string, unknown>) => {
        calls.push({ method, params })
        return responses.shift() ?? fail(`unexpected ${method}`)
      }
    } as Pick<RpcClient, 'sendRequest'> as RpcClient
  }
}

describe('resolveMobileBranchCompareBaseRef', () => {
  it('prefers the per-worktree base ref over the repo default', async () => {
    const { client, calls } = clientWith([
      ok({ worktree: { baseRef: 'origin/release' } }),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: 'origin/main' }] })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/release'
    )
    expect(calls.map((call) => call.method)).toEqual(['worktree.show', 'repo.list'])
  })

  it('falls back to repo worktreeBaseRef when the worktree has no pinned base', async () => {
    const { client } = clientWith([
      ok({ worktree: { baseRef: null } }),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: 'origin/main' }] })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/main'
    )
  })

  it('falls back to repo.baseRefDefault when metadata reads have no base', async () => {
    const { client, calls } = clientWith([
      fail('old host'),
      ok({ repos: [{ id: 'repo-1', worktreeBaseRef: null }] }),
      ok({ defaultBaseRef: 'origin/main' })
    ])

    await expect(resolveMobileBranchCompareBaseRef(client, 'repo-1::/tmp/wt')).resolves.toBe(
      'origin/main'
    )
    expect(calls.map((call) => call.method)).toEqual([
      'worktree.show',
      'repo.list',
      'repo.baseRefDefault'
    ])
  })
})
