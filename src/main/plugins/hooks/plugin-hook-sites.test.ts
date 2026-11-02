import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginHookName } from '../../../shared/plugins/contributions/plugin-hook-contribution'
import type { PluginHookChainOutcome } from '../../../shared/plugins/workers/plugin-hook-chain'
import { setPluginHookRunner } from './plugin-hook-dispatch'
import {
  applyWorkspaceCreatePluginHook,
  createFolderWorkspaceWithPluginHooks,
  notifyWorkspaceCreatedPluginHook
} from './workspace-create-plugin-hook'

type Decide = (event: PluginHookName, payload: unknown) => PluginHookChainOutcome

function installRunner(decide: Decide, wanted: readonly PluginHookName[] = []) {
  const run = vi.fn(async (event: PluginHookName, payload: unknown) => decide(event, payload))
  setPluginHookRunner({ wants: (event) => wanted.includes(event), run })
  return run
}

const rewrite =
  (changes: Record<string, unknown>): Decide =>
  (_event, payload) => ({
    kind: 'continue',
    payload: typeof payload === 'object' ? { ...payload, ...changes } : payload
  })

afterEach(() => {
  setPluginHookRunner(null)
})

describe('workspace.create hook sites', () => {
  const worktree = { id: 'repo-1', kind: 'git' as const }
  const folder = { id: 'repo-2', kind: 'folder' as const }

  it('applies a changed name, branch and base to a worktree request', async () => {
    const run = installRunner(rewrite({ name: 'feat-x', branch: 'me/feat-x', base: undefined }), [
      'workspace.create.before'
    ])
    const request = { name: 'x', baseBranch: 'origin/main', linkedPR: 4 }
    await expect(applyWorkspaceCreatePluginHook(request, worktree)).resolves.toEqual({
      name: 'feat-x',
      branchNameOverride: 'me/feat-x',
      baseBranch: undefined,
      linkedPR: 4
    })
    expect(run).toHaveBeenCalledWith('workspace.create.before', {
      kind: 'worktree',
      projectId: 'repo-1',
      name: 'x',
      base: 'origin/main'
    })
  })

  it('gives folder workspaces only a name to change', async () => {
    const run = installRunner(rewrite({ name: 'notes', branch: 'ignored' }), [
      'workspace.create.before'
    ])
    await expect(applyWorkspaceCreatePluginHook({ name: 'n' }, folder)).resolves.toEqual({
      name: 'notes'
    })
    expect(run).toHaveBeenCalledWith('workspace.create.before', {
      kind: 'folder',
      projectId: 'repo-2',
      name: 'n'
    })
  })

  it('refuses the create on a deny and passes the request through when unhooked', async () => {
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.naming', reason: 'bad name' }),
      ['workspace.create.before']
    )
    await expect(applyWorkspaceCreatePluginHook({ name: 'x' }, worktree)).rejects.toThrow(
      'workspace.create.before denied by plugin acme.naming: bad name'
    )
    setPluginHookRunner(null)
    const request = { name: 'x' }
    await expect(applyWorkspaceCreatePluginHook(request, worktree)).resolves.toBe(request)
  })

  it('tells observers about created worktrees and folders without waiting', () => {
    const run = installRunner(rewrite({}), ['workspace.create.after'])
    notifyWorkspaceCreatedPluginHook({
      worktreeId: 'repo-1::/w',
      path: '/w',
      branch: 'refs/heads/feat',
      folder: false
    })
    notifyWorkspaceCreatedPluginHook({
      worktreeId: 'folder:f',
      path: '/f',
      branch: '',
      folder: true
    })
    expect(run.mock.calls).toEqual([
      [
        'workspace.create.after',
        { workspaceId: 'repo-1::/w', kind: 'worktree', path: '/w', branch: 'feat' }
      ],
      [
        'workspace.create.after',
        { workspaceId: 'folder:f', kind: 'folder', path: '/f', branch: '' }
      ]
    ])
  })
})

describe('project-group folder workspace creates', () => {
  it('run the before hook on the name, create once, then tell observers', async () => {
    const run = installRunner(rewrite({ name: 'Notes (team)' }), [
      'workspace.create.before',
      'workspace.create.after'
    ])
    const create = vi.fn((input: { projectGroupId: string; name?: string }) => ({
      id: 'fw-1',
      folderPath: '/notes',
      name: input.name
    }))
    await expect(
      createFolderWorkspaceWithPluginHooks({ projectGroupId: 'g1', name: 'Notes' }, create)
    ).resolves.toMatchObject({ name: 'Notes (team)' })
    expect(create).toHaveBeenCalledOnce()
    expect(run.mock.calls).toEqual([
      ['workspace.create.before', { kind: 'folder', projectId: 'g1', name: 'Notes' }],
      [
        'workspace.create.after',
        { workspaceId: 'folder:fw-1', kind: 'folder', path: '/notes', branch: '' }
      ]
    ])
  })

  it('keep Orca’s default name when unnamed and unchanged, and create nothing on a deny', async () => {
    installRunner(rewrite({}), ['workspace.create.before'])
    const create = vi.fn((input: { projectGroupId: string; name?: string }) => ({
      id: 'fw-2',
      folderPath: '/x',
      name: input.name
    }))
    await createFolderWorkspaceWithPluginHooks({ projectGroupId: 'g1' }, create)
    expect(create).toHaveBeenCalledWith({ projectGroupId: 'g1' })
    installRunner(
      () => ({ kind: 'deny', pluginKey: 'acme.n', reason: 'no' }),
      ['workspace.create.before']
    )
    await expect(
      createFolderWorkspaceWithPluginHooks({ projectGroupId: 'g1' }, create)
    ).rejects.toThrow('denied by plugin acme.n')
    expect(create).toHaveBeenCalledOnce()
  })
})
