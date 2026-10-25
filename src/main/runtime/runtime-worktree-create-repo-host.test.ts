import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcContext, RpcRequest } from './rpc/core'
import { REPO_METHODS } from './rpc/methods/repo'
import { WORKTREE_METHODS } from './rpc/methods/worktree'
import { agentLaunchWorkspaceFactory } from './rpc/methods/agent-launch-worktree-creation'
import { OrcaRuntimeService } from './orca-runtime'

// Why twins: a project copied between hosts keeps its repo id (Codex review 6 #6).
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these paths stop right after repo resolution, which reads only these store methods.
  return new OrcaRuntimeService({
    getRepos: () => REPOS,
    getRepo: (id: string) => REPOS.find((repo) => repo.id === id) ?? null,
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => null,
    setWorktreeMeta: vi.fn(),
    getGitHubCache: () => null,
    getSettings: () => ({})
  } as never)
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

  it('agent.launch create-worktree keeps the host', async () => {
    const reached = stopAtResolvedProject()
    const runtime = createRuntime()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the create reads only `runtime` and the creator-provenance fields, which default when absent.
    const factory = agentLaunchWorkspaceFactory({ runtime } as unknown as RpcContext, 'claude')

    await expect(
      factory.createWorktree({
        create: { repo: 'id:dup', repoHostId: 'ssh:gpu', name: 'x' },
        startupAgent: 'claude'
      })
    ).rejects.toThrow('stop after resolution')

    expect(reached.mock.calls[0]?.[1]).toMatchObject({ path: '/remote/dup' })
  })

  it('a retried create for one host never coalesces with the same retry for another', async () => {
    const runtime = createRuntime()
    const run = vi.fn(async () => 'created')

    await runtime.dedupeWorktreeCreate({ repo: 'id:dup', repoHostId: 'local' }, 'retry-1', run)
    await runtime.dedupeWorktreeCreate({ repo: 'id:dup', repoHostId: 'ssh:gpu' }, 'retry-1', run)

    expect(run).toHaveBeenCalledTimes(2)
  })
})
