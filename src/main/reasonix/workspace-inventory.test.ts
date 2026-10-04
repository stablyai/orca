import { expect, it, vi } from 'vitest'
import { reasonixHostWorkspaceRoots } from './workspace-inventory'
import { mergeWorktreeMetaForWrite } from '../persistence/loading-store/worktree-meta-write-normalization'

it('uses the owning host inventory for git worktrees and plain folders', () => {
  const getAllWorktreeMeta = vi.fn(() => ({}))
  const getAllWorktreeMetaForHost = vi.fn(() => ({
    'local-repo::/work/branch': mergeWorktreeMetaForWrite(undefined, {}),
    'remote-repo::/remote/branch': mergeWorktreeMetaForWrite(undefined, {})
  }))
  const roots = reasonixHostWorkspaceRoots({
    getRepos: () => [
      { id: 'local-repo', path: '/work/repo' },
      { id: 'remote-repo', path: '/remote/repo', connectionId: 'remote' },
      { id: 'runtime-repo', path: '/runtime/repo', executionHostId: 'runtime:vm' }
    ],
    getAllWorktreeMeta,
    getAllWorktreeMetaForHost,
    getFolderWorkspaces: () => [
      { folderPath: '/work/plain' },
      { folderPath: '/remote/plain', connectionId: 'remote' },
      { folderPath: '/runtime/plain', executionHostId: 'runtime:vm' }
    ]
  })
  expect(roots).toEqual(['/work/repo', '/work/branch', '/work/plain'])
  expect(getAllWorktreeMetaForHost).toHaveBeenCalledExactlyOnceWith('local')
  expect(getAllWorktreeMeta).not.toHaveBeenCalled()
})

it('filters legacy host-qualified worktree metadata without reading another host', () => {
  expect(reasonixHostWorkspaceRoots(null)).toEqual([])
  expect(
    reasonixHostWorkspaceRoots({
      getRepos: () => [{ id: 'repo', path: '/same/repo' }],
      getAllWorktreeMeta: () => ({
        'repo::/work/local': mergeWorktreeMetaForWrite(undefined, { hostId: 'local' }),
        'repo::/work/ssh': mergeWorktreeMetaForWrite(undefined, { hostId: 'ssh:target' }),
        'repo::/work/runtime': mergeWorktreeMetaForWrite(undefined, { hostId: 'runtime:vm' })
      })
    })
  ).toEqual(['/same/repo', '/work/local'])
})
