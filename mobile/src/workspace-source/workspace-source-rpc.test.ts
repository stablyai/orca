import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { searchWorkspaceSources } from './workspace-source-rpc'

function ok(result: unknown) {
  return { ok: true as const, id: 'request', result }
}

describe('workspace source RPC planning', () => {
  it('fans empty All out to GitHub and Linear but not refs', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'github.listWorkItems') {
        return ok({ items: [], sources: { issues: null, prs: null } })
      }
      return ok([])
    })
    await searchWorkspaceSources({
      client: { sendRequest } as unknown as RpcClient,
      repoId: 'repo-1',
      query: '',
      filter: 'all',
      availability: { github: true, branches: true, linear: true }
    })
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'github.listWorkItems',
      'linear.listIssues'
    ])
  })

  it('fans a settled All query out to all three bounded reads', async () => {
    const sendRequest = vi.fn(async (method: string) => {
      if (method === 'github.listWorkItems') {
        return ok({ items: [], sources: { issues: null, prs: null } })
      }
      if (method === 'repo.searchRefs') {
        return ok({ refDetails: [], refs: [] })
      }
      return ok([])
    })
    await searchWorkspaceSources({
      client: { sendRequest } as unknown as RpcClient,
      repoId: 'repo-1',
      query: 'mobile',
      filter: 'all',
      availability: { github: true, branches: true, linear: true }
    })
    expect(sendRequest.mock.calls.map(([method]) => method)).toEqual([
      'github.listWorkItems',
      'repo.searchRefs',
      'linear.searchIssues'
    ])
    for (const [, params] of sendRequest.mock.calls) {
      expect(params.limit).toBe(12)
    }
  })

  it('names the selected host rather than the repository in GitHub errors', async () => {
    const sendRequest = vi.fn().mockRejectedValue(new Error('Authentication failed.'))
    const result = await searchWorkspaceSources({
      client: { sendRequest } as unknown as RpcClient,
      repoId: 'repo-1',
      query: '',
      filter: 'github',
      availability: { github: true, branches: true, linear: false }
    })

    expect(result.errors).toEqual(['Authentication failed. GitHub runs on the selected host.'])
  })
})
