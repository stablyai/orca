import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { ALL_RPC_METHODS } from '.'
import { GITEA_METHODS } from './gitea'
import { RPC_PARAMS_BY_METHOD } from '../../../../shared/rpc-contract/rpc-params-catalog.generated'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function makeDispatcher(runtime: Record<string, unknown>) {
  return new RpcDispatcher({
    runtime: {
      getRuntimeId: () => 'test-runtime',
      ...runtime
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these tests dispatch only the stubbed Gitea runtime methods.
    } as unknown as OrcaRuntimeService,
    methods: ALL_RPC_METHODS
  })
}

describe('gitea RPC methods', () => {
  it('registers every cataloged Gitea method in the default registry', () => {
    const registered = new Set<string>(ALL_RPC_METHODS.map((method) => method.name))
    for (const method of Object.keys(RPC_PARAMS_BY_METHOD).filter((name) =>
      name.startsWith('gitea.')
    )) {
      expect(registered.has(method), method).toBe(true)
    }
    for (const method of GITEA_METHODS) {
      expect(registered.has(method.name), method.name).toBe(true)
    }
  })

  it('serves gitea.listPRs instead of rejecting it as an unknown method', async () => {
    const page = { items: [], page: 1, perPage: 20, totalCount: 0, totalPages: 0 }
    const listGiteaRepoPRs = vi.fn().mockResolvedValue(page)
    const response = await makeDispatcher({ listGiteaRepoPRs }).dispatch(
      makeRequest('gitea.listPRs', {
        repo: 'id:repo-1',
        state: 'opened',
        page: 1,
        perPage: 20,
        query: 'fix'
      })
    )

    expect(listGiteaRepoPRs).toHaveBeenCalledWith('id:repo-1', 'opened', 1, 20, 'fix')
    expect(response).toMatchObject({ ok: true, result: page })
  })

  it('serves gitea.listIssues instead of rejecting it as an unknown method', async () => {
    const issues = { items: [], page: 1, perPage: 20, totalCount: 0, totalPages: 0 }
    const listGiteaRepoIssues = vi.fn().mockResolvedValue(issues)
    const response = await makeDispatcher({ listGiteaRepoIssues }).dispatch(
      makeRequest('gitea.listIssues', {
        repo: 'id:repo-1',
        state: 'opened',
        assignee: 'ana',
        limit: 20,
        page: 1
      })
    )

    expect(listGiteaRepoIssues).toHaveBeenCalledWith('id:repo-1', 'opened', 'ana', 20, 1)
    expect(response).toMatchObject({ ok: true, result: issues })
  })
})
