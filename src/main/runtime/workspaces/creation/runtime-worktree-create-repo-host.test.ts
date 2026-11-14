import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { RpcDispatcher } from '../../rpc/dispatcher'
import type { RpcRequest } from '../../rpc/core'
import { REPO_METHODS } from '../../rpc/methods/projects/repo'
import { WORKTREE_METHODS } from '../../rpc/methods/workspaces/worktree'
import '../../rpc/methods/agent-launch/agent-launch-worktree-creation'
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

/** Stops every create at the step that receives the resolved repo, and records that repo. */
function stopAtResolvedProject() {
  return vi
    .spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: spies on the private step that receives the resolved repo; it exists on the prototype.
      OrcaRuntimeService.prototype as unknown as {
        createInResolvedProject: (args: unknown, repo: Repo) => Promise<never>
      },
      'createInResolvedProject'
    )
    .mockRejectedValue(new Error('stop after resolution'))
}

function request(method: string, params: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('a repo id set up on two hosts, named with repoHostId', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('repo.show resolves the row on the named host and still refuses a bare id', async () => {
    const dispatcher = new RpcDispatcher({ runtime: createRuntime(), methods: REPO_METHODS })

    const named = await dispatcher.dispatch(
      request('repo.show', { repo: 'id:dup', repoHostId: 'ssh:gpu' })
    )
    const bare = await dispatcher.dispatch(request('repo.show', { repo: 'id:dup' }))

    expect(named).toMatchObject({ ok: true, result: { repo: { path: '/remote/dup' } } })
    expect(bare).toMatchObject({ ok: false, error: { code: 'selector_ambiguous' } })
  })

  it.each([
    ['plain', {}],
    ['with a startup agent', { startupAgent: 'claude' }],
    ['with a linked startup draft', { startupDraft: 'Fix the bug' }]
  ])('worktree.create keeps the host through every lookup (%s)', async (_label, extra) => {
    const reached = stopAtResolvedProject()
    const dispatcher = new RpcDispatcher({ runtime: createRuntime(), methods: WORKTREE_METHODS })

    await dispatcher.dispatch(
      request('worktree.create', { repo: 'id:dup', repoHostId: 'local', name: 'x', ...extra })
    )

    expect(reached).toHaveBeenCalledTimes(1)
    expect(reached.mock.calls[0]?.[1]).toMatchObject({ path: '/laptop/dup' })
  })
})
