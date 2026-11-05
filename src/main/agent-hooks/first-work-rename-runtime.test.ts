import { describe, expect, it, vi } from 'vitest'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { captureFirstWorkBranchOwner } from './first-work-branch-revision'
import { makeBranchRenameDeps, REPO_ID, WORKTREE_ID } from './first-work-branch-rename-test-harness'
import { firstWorkRenameDeps } from './first-work-rename-runtime'

function runtimeDeps(meta: { current: Partial<WorktreeMeta> }, folder?: Partial<FolderWorkspace>) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner revision reads only getWorktreeMeta and getFolderWorkspace.
  const store = {
    getWorktreeMeta: () => meta.current,
    getFolderWorkspace: () => folder
  } as unknown as Parameters<typeof firstWorkRenameDeps>[0]
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner revision never touches the runtime.
  return firstWorkRenameDeps(store, {} as Parameters<typeof firstWorkRenameDeps>[1])
}

describe('first-work rename owner revision', () => {
  it('stays current across sidebar sort-stamp writes and changes for a new instance', () => {
    const meta: { current: Partial<WorktreeMeta> } = {
      current: { instanceId: 'one', lastActivityAt: 1 }
    }
    const deps = runtimeDeps(meta)
    const { deps: renameDeps } = makeBranchRenameDeps(vi.fn, {
      getRenameOwnerRevision: deps.getRenameOwnerRevision
    })
    const repo = renameDeps.getRepo(REPO_ID)!
    const current = captureFirstWorkBranchOwner(WORKTREE_ID, repo, renameDeps, () => true)
    expect(current()).toBe(true)

    meta.current = { ...meta.current, lastActivityAt: 2, smartAt: 3 }
    expect(current()).toBe(true)

    meta.current = { ...meta.current, instanceId: 'two' }
    expect(current()).toBe(false)
  })

  it('ignores folder workspace activity writes but not a different folder', () => {
    const folder = { id: 'f', createdAt: 1, folderPath: '/a', lastActivityAt: 1 }
    const deps = runtimeDeps({ current: {} }, folder)
    const before = deps.getRenameOwnerRevision?.('folder:f')
    folder.lastActivityAt = 2
    expect(deps.getRenameOwnerRevision?.('folder:f')).toBe(before)
    folder.folderPath = '/b'
    expect(deps.getRenameOwnerRevision?.('folder:f')).not.toBe(before)
  })
})
