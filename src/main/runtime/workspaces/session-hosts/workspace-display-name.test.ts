import { expect, it, vi } from 'vitest'
import { OrcaRuntimeWithGetRuntimeId } from './get-runtime-id'

const WSL_REPO = String.raw`52390e5d-872a-4a89-a008-7c6cd8e1c3b3::\\wsl.localhost\Ubuntu\home\orcatest\repo`

function runtimeWith(
  folders: number,
  worktrees: { id: string; repoId: string; displayName: string }[] | null
) {
  const store = {
    getWorktreeMeta: vi.fn(() => undefined),
    getRepo: vi.fn((id: string) =>
      id === '52390e5d-872a-4a89-a008-7c6cd8e1c3b3' ? { displayName: 'repo' } : undefined
    ),
    getFolderWorkspace: vi.fn((id: string) => (id === 'folder-1' ? { name: 'Docs' } : undefined)),
    getFolderWorkspaces: vi.fn(() =>
      Array.from({ length: folders }, (_, index) => ({ id: `folder-${index}`, name: 'f' }))
    )
  }
  const runtime = Object.assign(Object.create(OrcaRuntimeWithGetRuntimeId.prototype), {
    store,
    resolvedWorktrees: { peek: () => (worktrees ? { worktrees } : null) },
    buildResolvedWorktreeFromId: vi.fn(() => null)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method reads only the store, the resolved-worktree cache and the keyed resolver set above.
  return { runtime: runtime as OrcaRuntimeWithGetRuntimeId, store }
}

it.each([750, 7_500])(
  'labels one workspace from its own records, whatever the other %i folder workspaces',
  (folders) => {
    const { runtime, store } = runtimeWith(folders, [
      { id: WSL_REPO, repoId: '52390e5d-872a-4a89-a008-7c6cd8e1c3b3', displayName: 'repo' }
    ])

    // A WSL worktree with no saved name reads as `agent list` shows it, not as its raw id.
    expect(runtime.getWorkspaceLabel(WSL_REPO)).toEqual({ workspace: 'repo', repo: 'repo' })
    expect(runtime.getWorkspaceLabel('folder:folder-1')).toEqual({ workspace: 'Docs' })
    expect(store.getFolderWorkspaces).not.toHaveBeenCalled()
  }
)

it('labels nothing it has no record of, so the caller shows the id', () => {
  const { runtime } = runtimeWith(0, null)

  expect(runtime.getWorkspaceLabel(WSL_REPO)).toBeNull()
})
