import '../../../providers/ssh-host-not-served-error'
import { describe, expect, it } from 'vitest'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../../../shared/orca-profiles/constants'
import '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../git/worktrees/creation/worktree-sparse-add'
import '../../../git/worktrees/creation/worktree-add'
import { join } from 'node:path'
import '../../../git/worktrees/catalog/worktree-scan-cache'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import '../../rpc/dispatcher'
import '../../rpc/methods/terminal/terminal'
import {
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'

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
})
