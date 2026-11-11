import 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import '../../preflight/agent-command-detection'
import './runtime-test-module-registration.spec'
import '../../../shared/constants'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../../shared/agent-launch/startup/setup-agent-sequencing'
import { join } from 'node:path'

import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  TEST_FOLDER_WORKSPACE_ID,
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderProjectGroup,
  makeFolderWorkspace
} from './orca-runtime-test-fixtures.spec'
import '../terminal/launch/spawned-pty-env-fixtures'

describe('OrcaRuntimeService', () => {
  it('rejects folder workspace terminal creation when the backing path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-workspace-${randomUUID()}`)
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-folder' })
    const folderWorkspace = makeFolderWorkspace({ folderPath: missingPath })
    const projectGroup = makeFolderProjectGroup({ parentPath: missingPath })
    const runtime = new OrcaRuntimeService(
      createFolderWorkspaceRuntimeStore(folderWorkspace, projectGroup) as never
    )
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await expect(runtime.createTerminal(TEST_FOLDER_WORKSPACE_KEY)).rejects.toThrow(
      'folder_workspace_path_missing'
    )
    expect(spawn).not.toHaveBeenCalled()
  })

  it('rejects folder workspace folderPath updates when the new path is missing', async () => {
    const missingPath = join(tmpdir(), `orca-missing-folder-update-${randomUUID()}`)
    const folderWorkspace = makeFolderWorkspace()
    const runtimeStore = {
      ...createFolderWorkspaceRuntimeStore(folderWorkspace),
      updateFolderWorkspace: vi.fn()
    }
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.updateFolderWorkspace(TEST_FOLDER_WORKSPACE_ID, { folderPath: missingPath })
    ).rejects.toThrow('folder_workspace_path_missing')
    expect(runtimeStore.updateFolderWorkspace).not.toHaveBeenCalled()
  })
})
