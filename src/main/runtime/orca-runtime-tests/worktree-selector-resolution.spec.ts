import '../../providers/ssh-host-not-served-error'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import '../../../shared/constants'
import {
  MOCK_GIT_WORKTREES,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock
} from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../git/worktrees/creation/worktree-sparse-add'
import '../../git/worktrees/creation/worktree-add'
import { join } from 'node:path'
import { listWorktrees } from '../../git/worktrees/catalog/worktree-scan-cache'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import '../rpc/dispatcher'
import '../rpc/methods/terminal/terminal'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  TEST_REPO_ID,
  TEST_WORKTREE_ID,
  createFolderWorkspaceRuntimeStore,
  deferred,
  makeFolderProjectGroup,
  makeFolderWorkspace,
  store
} from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it.each([
    { label: 'canonical folder workspace selector', selector: TEST_FOLDER_WORKSPACE_KEY },
    { label: 'id-prefixed folder workspace selector', selector: `id:${TEST_FOLDER_WORKSPACE_KEY}` }
  ])('reads file explorer paths for a $label', async ({ selector }) => {
    const folderPath = await mkdtemp(join(tmpdir(), 'orca-runtime-folder-files-'))
    await mkdir(join(folderPath, 'src'))
    await writeFile(join(folderPath, 'src', 'app.ts'), 'export {}\n')
    const folderWorkspace = makeFolderWorkspace({ folderPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: folderPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )

    await expect(runtime.readFileExplorerDir(selector, 'src')).resolves.toContainEqual({
      name: 'app.ts',
      isDirectory: false,
      isSymlink: false
    })
    await expect(runtime.readFileExplorerPreview(selector, 'src/app.ts')).resolves.toMatchObject({
      content: 'export {}\n',
      isBinary: false
    })
  })

  it('does not reuse stale in-flight worktree scans after creating a worktree', async () => {
    const addRetiredWorktreeName = vi.fn()
    const runtime = new OrcaRuntimeService({
      ...store,
      addRetiredWorktreeName,
      getRetiredWorktreeNameRegistry: () => ({
        exhaustedTiers: 0,
        names: Array.from({ length: 100 }, (_unused, index) =>
          index === 0 ? 'nautilus' : `nautilus-${index + 1}`
        )
      })
    })
    const staleScan = deferred<typeof MOCK_GIT_WORKTREES>()
    const createdWorktree = {
      path: '/tmp/workspaces/repo-nautilus-101',
      head: 'def',
      branch: 'nautilus-101',
      isBare: false,
      isMainWorktree: false
    }
    computeWorktreePathMock.mockReturnValue(createdWorktree.path)
    ensurePathWithinWorkspaceMock.mockReturnValue(createdWorktree.path)
    vi.mocked(listWorktrees)
      .mockImplementationOnce(() => staleScan.promise)
      .mockResolvedValueOnce([createdWorktree])
      // listDetected prunes after the create, so it observes again with its own pre-scan claim.
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])
      .mockResolvedValueOnce([...MOCK_GIT_WORKTREES, createdWorktree])

    const staleLookup = runtime.showManagedWorktree(TEST_WORKTREE_ID)
    const result = await runtime.createManagedWorktree({
      repoSelector: 'id:repo-1',
      name: 'nautilus',
      nameWasGenerated: true
    })
    const freshLookup = runtime.showManagedWorktree(result.worktree.id)

    staleScan.resolve(MOCK_GIT_WORKTREES)

    await expect(staleLookup).resolves.toMatchObject({ id: TEST_WORKTREE_ID })
    await expect(freshLookup).resolves.toMatchObject({
      id: result.worktree.id,
      path: createdWorktree.path
    })
    await expect(runtime.listDetectedManagedWorktrees(`id:${TEST_REPO_ID}`)).resolves.toMatchObject(
      {
        worktrees: expect.arrayContaining([expect.objectContaining({ path: createdWorktree.path })])
      }
    )
    expect(addRetiredWorktreeName).toHaveBeenCalledWith(TEST_REPO_ID, 'nautilus-101')
  })
})
