import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { GITHUB_METHODS } from './github'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function githubDispatcher(
  runtime: Pick<OrcaRuntimeService, 'getRuntimeId'> & Partial<OrcaRuntimeService>
) {
  return new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each case supplies the envelope identity and every runtime method its selected GitHub handlers access.
    runtime: runtime as OrcaRuntimeService,
    methods: GITHUB_METHODS
  })
}

const fork = { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }

describe('github RPC methods', () => {
  it('looks up a work item by the addressed owner and repository', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoWorkItemByOwnerRepo: vi.fn().mockResolvedValue({ number: 12, type: 'pr' })
    }
    const dispatcher = githubDispatcher(runtime)

    const response = await dispatcher.dispatch(
      makeRequest('github.workItemByOwnerRepo', {
        repo: 'repo-1',
        owner: 'acme',
        ownerRepo: 'orca',
        number: 12,
        type: 'pr'
      })
    )

    expect(runtime.getRepoWorkItemByOwnerRepo).toHaveBeenCalledWith(
      'repo-1',
      { owner: 'acme', repo: 'orca' },
      12,
      'pr',
      { preview: false }
    )
    expect(response).toMatchObject({ ok: true, result: { number: 12, type: 'pr' } })
  })

  it.each([undefined, fork])(
    'fetches work item details for the addressed repository and does not invent one: %j',
    async (ownerRepo) => {
      const runtime = {
        getRuntimeId: () => 'test-runtime',
        getRepoWorkItemDetails: vi.fn().mockResolvedValue({ body: 'Details' })
      }
      const dispatcher = githubDispatcher(runtime)

      const response = await dispatcher.dispatch(
        makeRequest('github.workItemDetails', {
          repo: 'repo-1',
          number: 12,
          type: 'pr',
          ...(ownerRepo ? { ownerRepo } : {})
        })
      )

      expect(runtime.getRepoWorkItemDetails).toHaveBeenCalledWith(
        'repo-1',
        12,
        'pr',
        ...(ownerRepo ? [ownerRepo] : [])
      )
      expect(response).toMatchObject({ ok: true, result: { body: 'Details' } })
    }
  )

  it('fetches pull request file contents from the addressed repository', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      getRepoPRFileContents: vi.fn().mockResolvedValue({
        original: '',
        modified: 'new',
        originalIsBinary: false,
        modifiedIsBinary: false
      })
    }
    const dispatcher = githubDispatcher(runtime)

    const response = await dispatcher.dispatch(
      makeRequest('github.prFileContents', {
        repo: 'repo-1',
        prNumber: 7,
        prRepo: fork,
        path: 'src/app.ts',
        status: 'modified',
        headSha: 'head',
        baseSha: 'base'
      })
    )

    expect(runtime.getRepoPRFileContents).toHaveBeenCalledWith('repo-1', {
      prNumber: 7,
      prRepo: fork,
      path: 'src/app.ts',
      oldPath: undefined,
      status: 'modified',
      headSha: 'head',
      baseSha: 'base'
    })
    expect(response).toMatchObject({ ok: true, result: { modified: 'new' } })
  })

  it('marks a pull request file viewed on the addressed repository', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      setRepoPRFileViewed: vi.fn().mockResolvedValue(true)
    }
    const dispatcher = githubDispatcher(runtime)

    const response = await dispatcher.dispatch(
      makeRequest('github.setPRFileViewed', {
        repo: 'repo-1',
        prRepo: fork,
        pullRequestId: 'PR_kwDO123',
        path: 'src/app.ts',
        viewed: true
      })
    )

    expect(runtime.setRepoPRFileViewed).toHaveBeenCalledWith('repo-1', {
      prRepo: fork,
      pullRequestId: 'PR_kwDO123',
      path: 'src/app.ts',
      viewed: true
    })
    expect(response).toMatchObject({ ok: true, result: true })
  })
})
