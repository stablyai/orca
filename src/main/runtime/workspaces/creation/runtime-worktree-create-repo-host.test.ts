import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { RpcDispatcher } from '../../rpc/dispatcher'
import type { RpcRequest } from '../../rpc/core'
import { REPO_METHODS } from '../../rpc/methods/projects/repo'
import { OrcaRuntimeService } from '../../orca-runtime'
import { partialRuntimeStore } from '../../orca-runtime-tests/runtime-store-partial-fixture'

// Projects copied between hosts retain their repo id.
const REPOS: Repo[] = [
  {
    id: 'dup',
    path: '/laptop/dup',
    displayName: 'Dup',
    badgeColor: '#000',
    addedAt: 1,
    kind: 'git',
    executionHostId: 'local'
  },
  {
    id: 'dup',
    path: '/remote/dup',
    displayName: 'Dup',
    badgeColor: '#000',
    addedAt: 2,
    kind: 'git',
    executionHostId: 'ssh:gpu'
  }
]

function createRuntime(): OrcaRuntimeService {
  return new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => REPOS,
      getRepo: (id: string) => REPOS.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getSettings: () => ({})
    })
  )
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('a repo id set up on two hosts, named with repoHostId', () => {
  it('repo.show resolves the row on the named host and still refuses a bare id', async () => {
    const dispatcher = new RpcDispatcher({ runtime: createRuntime(), methods: REPO_METHODS })

    const named = await dispatcher.dispatch(
      request('repo.show', { repo: 'id:dup', repoHostId: 'ssh:gpu' })
    )
    const bare = await dispatcher.dispatch(request('repo.show', { repo: 'id:dup' }))

    expect(named).toMatchObject({ ok: true, result: { repo: { path: '/remote/dup' } } })
    expect(bare).toMatchObject({ ok: false, error: { code: 'selector_ambiguous' } })
  })
})
