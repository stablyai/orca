import { describe, expect, it, vi } from 'vitest'
import { callPluginHost, pluginHostTestServices } from './__mocks__/plugin-host-services-fixture'

describe('workspace.create branch', () => {
  it('creates the workspace on the branch the plugin names, not one derived from its name', async () => {
    const runtimeRpc = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'repo.list') {
        return { repos: [{ id: 'repo-1', kind: 'git', executionHostId: 'local' }] }
      }
      if (method === 'worktree.list') {
        return { worktrees: [] }
      }
      if (method === 'worktree.create') {
        return { worktree: { id: 'wt-1::/repo' } }
      }
      throw new Error(`unexpected runtime method: ${method}`)
    })

    const outcome = await callPluginHost({
      method: 'workspace.create',
      params: { projectId: 'repo-1', name: 'feature-work', branch: 'feature/PROJ-1' },
      granted: ['workspace:create'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(outcome).toEqual({ ok: true, value: { workspaceId: 'wt-1::/repo' } })
    expect(runtimeRpc).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ name: 'feature-work', branchNameOverride: 'feature/PROJ-1' }),
      expect.anything()
    )
  })

  it('leaves branchNameOverride out when the plugin does not name a branch', async () => {
    const runtimeRpc = vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'repo.list') {
        return { repos: [{ id: 'repo-1', kind: 'git', executionHostId: 'local' }] }
      }
      if (method === 'worktree.list') {
        return { worktrees: [] }
      }
      if (method === 'worktree.create') {
        return { worktree: { id: 'wt-1::/repo' } }
      }
      throw new Error(`unexpected runtime method: ${method}`)
    })

    const outcome = await callPluginHost({
      method: 'workspace.create',
      params: { projectId: 'repo-1', name: 'feature-work' },
      granted: ['workspace:create'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(outcome).toEqual({ ok: true, value: { workspaceId: 'wt-1::/repo' } })
    const createParams = runtimeRpc.mock.calls.find(([method]) => method === 'worktree.create')?.[1]
    expect(createParams).toMatchObject({ name: 'feature-work' })
    expect(createParams).not.toHaveProperty('branchNameOverride')
  })

  it.each(['feature..PROJ-1', 'HEAD'])('refuses %s before creating anything', async (branch) => {
    const runtimeRpc = vi.fn(async () => ({}))

    const outcome = await callPluginHost({
      method: 'workspace.create',
      params: { projectId: 'repo-1', branch },
      granted: ['workspace:create'],
      services: pluginHostTestServices(runtimeRpc)
    })

    expect(outcome).toEqual({
      ok: false,
      code: 'invalid_params',
      error: 'branch: branch must be a valid Git branch name'
    })
    expect(runtimeRpc).not.toHaveBeenCalled()
  })
})
