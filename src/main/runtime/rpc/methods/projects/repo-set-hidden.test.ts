import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host'
import { RpcDispatcher } from '../../dispatcher'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { partialRuntimeStore } from '../../../orca-runtime-tests/runtime-store-partial-fixture'
import { REPO_METHODS } from './repo'

function makeRuntime(repos: Repo[]): OrcaRuntimeService {
  return new OrcaRuntimeService(
    partialRuntimeStore({
      getRepos: () => repos,
      getRepo: (id: string) => repos.find((repo) => repo.id === id),
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getSettings: () => ({}),
      updateRepo: (target: Repo, updates: { hiddenAt?: number | null }) => {
        const row = repos.find(
          (repo) =>
            repo.id === target.id && getRepoExecutionHostId(repo) === getRepoExecutionHostId(target)
        )
        if (!row) {
          return null
        }
        if (updates.hiddenAt === null || updates.hiddenAt === undefined) {
          delete row.hiddenAt
        } else {
          row.hiddenAt = updates.hiddenAt
        }
        return row
      }
    })
  )
}

function call(dispatcher: RpcDispatcher, params: unknown) {
  return dispatcher.dispatch({ id: 'req-1', authToken: 'tok', method: 'repo.setHidden', params })
}

describe('repo.setHidden', () => {
  it('hides and shows only the named host’s copy and answers host-qualified', async () => {
    const repos: Repo[] = [
      {
        id: 'dup',
        path: '/l',
        displayName: 'Dup',
        badgeColor: '',
        addedAt: 1,
        executionHostId: 'local'
      },
      {
        id: 'dup',
        path: '/r',
        displayName: 'Dup',
        badgeColor: '',
        addedAt: 2,
        executionHostId: 'ssh:gpu'
      }
    ]
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime(repos), methods: REPO_METHODS })

    const hidden = await call(dispatcher, { repo: 'id:dup', repoHostId: 'ssh:gpu', hidden: true })
    expect(hidden).toMatchObject({
      ok: true,
      result: {
        hostId: 'ssh:gpu',
        hidden: true,
        repo: { path: '/r', hiddenAt: expect.any(Number) }
      }
    })
    expect(repos[0]?.hiddenAt).toBeUndefined()

    const shown = await call(dispatcher, { repo: 'id:dup', repoHostId: 'ssh:gpu', hidden: false })
    expect(shown).toMatchObject({ ok: true, result: { hostId: 'ssh:gpu', hidden: false } })
    expect(repos[1]?.hiddenAt).toBeUndefined()
  })

  it('rejects a call without a boolean hidden', async () => {
    const dispatcher = new RpcDispatcher({ runtime: makeRuntime([]), methods: REPO_METHODS })
    expect(await call(dispatcher, { repo: 'id:dup' })).toMatchObject({ ok: false })
  })
})
