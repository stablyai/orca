import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { Repo } from '../../../../shared/repo-types'
import { REPO_METHODS } from './repo'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

function dispatcherFor(updated: Partial<Repo>) {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    updateRepo: vi.fn<OrcaRuntimeService['updateRepo']>().mockResolvedValue({
      id: 'repo-1',
      path: '/srv/repo',
      displayName: 'repo',
      badgeColor: '#000000',
      addedAt: 0,
      ...updated
    }),
    notifyWorktreesChanged: vi.fn<OrcaRuntimeService['notifyWorktreesChanged']>()
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: repo.update only calls getRuntimeId, updateRepo and notifyWorktreesChanged.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: REPO_METHODS
  })
  return { runtime, dispatcher }
}

describe('repo.update worktree visibility refresh', () => {
  it('persists agent worktree visibility updates', async () => {
    const { runtime, dispatcher } = dispatcherFor({ agentWorktreeVisibility: 'show' })

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', { repo: 'repo-1', updates: { agentWorktreeVisibility: 'show' } })
    )

    expect(runtime.updateRepo).toHaveBeenCalledWith('repo-1', { agentWorktreeVisibility: 'show' })
    expect(response).toMatchObject({
      ok: true,
      result: { repo: { id: 'repo-1', agentWorktreeVisibility: 'show' } }
    })
  })

  // Why: a CLI `repo set --external-worktree-visibility show` hid the worktree instead of listing it.
  it.each([
    { externalWorktreeVisibility: 'show' },
    { importedExternalWorktreePaths: ['/srv/repo-x'] },
    { agentWorktreeVisibility: 'show' },
    { worktreeBasePath: '/srv/worktrees' },
    { customWorktreeVisibilitySources: [{ id: 'scratch', rootPath: '/srv/scratch' }] },
    { worktreeVisibilitySourcePreferences: { builtIn: { claude: 'show' } } }
  ])('asks clients to re-read worktrees after a visibility update %o', async (updates) => {
    const { runtime, dispatcher } = dispatcherFor({})

    const response = await dispatcher.dispatch(
      makeRequest('repo.update', { repo: 'path:/srv/repo', updates })
    )

    expect(response).toMatchObject({ ok: true })
    expect(runtime.notifyWorktreesChanged).toHaveBeenCalledWith('repo-1')
  })

  it('leaves worktree rows alone for updates that do not affect visibility', async () => {
    const { runtime, dispatcher } = dispatcherFor({ displayName: 'renamed' })

    await dispatcher.dispatch(
      makeRequest('repo.update', { repo: 'repo-1', updates: { displayName: 'renamed' } })
    )

    expect(runtime.notifyWorktreesChanged).not.toHaveBeenCalled()
  })
})
