import { describe, expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { createFolderWorkspaceRuntimeStore, makeFolderWorkspace } =
  await import('./orca-runtime-test-fixtures.spec')

describe('deleting a folder workspace', () => {
  it('announces the removal to worktree lifecycle listeners under its folder key', async () => {
    const folderWorkspace = makeFolderWorkspace({ folderPath: '/tmp/folder-ws' })
    const runtime = new OrcaRuntimeService({
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      removeFolderWorkspace: () => true
    })
    const listener = vi.fn()
    runtime.onWorktreeLifecycle(listener)
    await expect(runtime.deleteFolderWorkspace(folderWorkspace.id)).resolves.toEqual({
      deleted: true
    })
    expect(listener).toHaveBeenCalledWith({
      kind: 'removed',
      worktreeId: `folder:${folderWorkspace.id}`,
      path: '/tmp/folder-ws'
    })
  })
})
